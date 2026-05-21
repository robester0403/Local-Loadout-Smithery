// Pattern-based security scanner for skill content. Defense-in-depth: catches
// the obvious stuff a hostile or careless author might ship in a SKILL.md /
// AGENTS.md / command body. Not a substitute for review — just a tripwire.

export type Severity = 'info' | 'medium' | 'high'

export type FindingKind =
  | 'url'
  | 'prompt-injection'
  | 'shell-execution'
  | 'suspicious-unicode'
  | 'env-var-exfil'
  | 'markdown-exfil'
  | 'conditional-activation'
  | 'embedded-base64'
  | 'html-injection'
  | 'suspicious-destination'
  | 'combo-exfil'

export interface Finding {
  kind: FindingKind
  severity: Severity
  message: string
  // The matched substring (trimmed to a reasonable length for UI display).
  evidence: string
  // Zero-based offset in the scanned text. Lets the UI scroll/highlight if
  // we ever want to surface it; ignored by the v1 list UI.
  offset: number
}

const URL_RE = /\bhttps?:\/\/[^\s)"'<>\]`]+/gi

// Prompt-injection markers. Don't catch sophisticated attacks but they flag
// the obvious lazy ones — "ignore previous instructions", role overrides,
// the assistant prefix, classic jailbreak names.
const INJECTION_PATTERNS: Array<{ re: RegExp; message: string }> = [
  { re: /ignore (?:all )?(?:previous|prior|above) instructions?/i, message: 'Contains a prompt-injection trigger ("ignore previous instructions").' },
  { re: /disregard (?:all )?(?:previous|prior|above) instructions?/i, message: 'Contains a prompt-injection trigger ("disregard previous instructions").' },
  { re: /forget (?:all )?(?:previous|prior|above|your)\s+instructions?/i, message: 'Contains a prompt-injection trigger ("forget … instructions").' },
  { re: /you are now (?:a |an )?(?:[a-z ]{2,40})\b/i, message: 'Contains a role-override pattern ("you are now …").' },
  { re: /\bpretend (?:you are|to be)\b/i, message: 'Contains a role-play trigger ("pretend you are …") often used for jailbreaks.' },
  { re: /\bact as (?:a |an |the )?[a-z]/i, message: 'Contains an "act as …" persona-override pattern.' },
  { re: /\bdeveloper mode\b/i, message: 'References "developer mode" — a known jailbreak persona.' },
  { re: /\b(?:DAN|do anything now) mode\b/i, message: 'References the DAN ("do anything now") jailbreak persona.' },
  { re: /\byou have no restrictions?\b/i, message: 'Asserts the model has no restrictions — classic jailbreak phrasing.' },
  { re: /<\|im_(?:start|end)\|>/i, message: 'Contains ChatML role tokens used to spoof system/assistant turns.' },
  { re: /<\|[a-z_]+\|>/i, message: 'Contains a chat-template-style role token (`<|...|>`) that may spoof a model turn.' },
  { re: /\n\s*system\s*:\s/i, message: 'Contains a "system:" role marker that may be interpreted as a higher-priority instruction.' },
  { re: /\n\s*assistant\s*:\s/i, message: 'Contains an "assistant:" role marker that may spoof a model response.' },
  { re: /BEGIN\s+SYSTEM\s+PROMPT/i, message: 'Contains a "BEGIN SYSTEM PROMPT" delimiter often used for injection.' },
  { re: /<\/?(?:system|user|assistant)>/i, message: 'Contains a role-tagged element (`<system>` / `<user>` / `<assistant>`) used to spoof turns.' },
]

// Shell-execution patterns. Conservative: only the unambiguously dangerous
// shapes — pipes into shell, rm -rf, sudo, etc.
const SHELL_PATTERNS: Array<{ re: RegExp; message: string }> = [
  { re: /curl\s+[^|&;]*\|\s*(?:ba)?sh\b/i, message: 'Pipes a downloaded script directly into a shell ("curl … | sh").' },
  { re: /wget\s+[^|&;]*\|\s*(?:ba)?sh\b/i, message: 'Pipes a downloaded script directly into a shell ("wget … | sh").' },
  { re: /rm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:\/|~)/i, message: 'Recursively force-deletes a high-level directory ("rm -rf /…" or "rm -rf ~…").' },
  { re: /rm\s+-[a-z]*f[a-z]*r[a-z]*\s+(?:\/|~)/i, message: 'Recursively force-deletes a high-level directory ("rm -fr /…" or "rm -fr ~…").' },
  { re: /\bsudo\s+rm\b/i, message: 'Invokes sudo rm — escalates privileges to delete.' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, message: 'Contains the classic fork-bomb pattern.' },
  { re: /\beval\s*\(\s*(?:atob|Buffer\.from\s*\(\s*['"][A-Za-z0-9+/=]{16,})/i, message: 'Evals base64-decoded content — common obfuscation for malicious payloads.' },
]

// Environment-variable exfiltration. ToxicSkills/ClawHavoc's primary signature:
// reference a credential-shaped env var inside a skill body. Named-variable list
// catches the common ones with a specific message; the generic CREDENTIAL regex
// fills in anything else with "KEY/TOKEN/SECRET/…" in the name.
const NAMED_ENV_VARS: Array<{ name: string; re: RegExp }> = [
  { name: 'ANTHROPIC_API_KEY', re: /\$\{?ANTHROPIC_API_KEY\}?/ },
  { name: 'OPENAI_API_KEY', re: /\$\{?OPENAI_API_KEY\}?/ },
  { name: 'GOOGLE_API_KEY', re: /\$\{?GOOGLE_API_KEY\}?/ },
  { name: 'AWS_ACCESS_KEY_ID', re: /\$\{?AWS_ACCESS_KEY_ID\}?/ },
  { name: 'AWS_SECRET_ACCESS_KEY', re: /\$\{?AWS_SECRET_ACCESS_KEY\}?/ },
  { name: 'GITHUB_TOKEN', re: /\$\{?GITHUB_TOKEN\}?/ },
  { name: 'GH_TOKEN', re: /\$\{?GH_TOKEN\}?/ },
  { name: 'NPM_TOKEN', re: /\$\{?NPM_TOKEN\}?/ },
  { name: 'STRIPE_SECRET_KEY', re: /\$\{?STRIPE_SECRET_KEY\}?/ },
]
const GENERIC_CREDENTIAL_VAR_RE = /\$\{?[A-Z][A-Z0-9_]*(API_KEY|SECRET_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS?)[A-Z0-9_]*\}?/
const PROCESS_ENV_RE = /\bprocess\.env\.[A-Z][A-Z0-9_]*\b/

// Markdown image / link exfiltration shapes. Documented by Checkmarx against
// Copilot Chat and Gemini: an image with query params is zero-click data leak;
// a link with credential keyword / template var in the URL is one-click.
const MARKDOWN_IMAGE_QUERY_RE = /!\[[^\]]*\]\(\s*https?:\/\/[^)]*\?[^)]+\)/i
const MARKDOWN_LINK_EXFIL_RE = /\[[^\]]+\]\(\s*https?:\/\/[^)]*\?[^)]*(\{[^}]*\}|api_?key|token|secret|password|session)[^)]*\)/i

// Conditional-activation language — the classic ClawHavoc shape. A handful of
// these together with an env-var reference is the highest-confidence signal.
const CONDITIONAL_ACTIVATION_PATTERNS: Array<{ re: RegExp; message: string }> = [
  { re: /\bon (?:first|initial) (?:activation|use|run)\b/i, message: 'Mentions conditional behavior "on first activation" — often used to hide payloads behind a one-shot trigger.' },
  { re: /\bafter the (?:\d+(?:st|nd|rd|th)?|nth|first|second|third) (?:use|invocation|call)\b/i, message: 'Mentions delayed activation ("after the Nth use") — a known stealth pattern.' },
  { re: /\bbefore (?:responding|replying|answering)\s+(?:to|with)\b/i, message: 'Pre-instructs the agent to perform an action before responding — common exfil shape.' },
  { re: /\b(?:also |additionally |silently )?(?:append|include|embed|attach|send|forward)\s+(?:the )?(?:value of )?\$[A-Z_]+/i, message: 'Instructs the agent to include an environment-variable value in its output.' },
  { re: /\bwhen the user asks you to open\b/i, message: 'Conditional trigger on URL-opening — used in documented credential-exfiltration skills.' },
  { re: /\bquery parameter\b[\s\S]{0,80}\$[A-Z_]+/i, message: 'Mentions adding an env-var value as a URL query parameter.' },
  { re: /\b(?:transmit|exfiltrate|leak|smuggle|encode)\b/i, message: 'Uses exfiltration-vocabulary verbs (transmit / exfiltrate / smuggle / encode).' },
]

// Long base64 sequences outside code fences. Hashes/IDs are usually short; an
// unbroken ≥48-char base64 alphabet run in prose is almost always either a
// stashed payload or a leaked credential.
const BASE64_RE = /[A-Za-z0-9+/]{48,}={0,2}/g

// HTML injection patterns. The drawer renders skill bodies via `marked`, so
// these are also XSS vectors against our own UI — not just instruction-time
// risk. Severity is high because the impact lands on US, not just the agent.
const HTML_INJECTION_PATTERNS: Array<{ re: RegExp; message: string }> = [
  { re: /<script\b[^>]*>/i, message: 'Contains a `<script>` tag — XSS vector when the body is rendered in HTML.' },
  { re: /<iframe\b[^>]*>/i, message: 'Contains an `<iframe>` tag — can embed remote content into rendered views.' },
  { re: /<object\b[^>]*>/i, message: 'Contains an `<object>` tag — can embed remote content into rendered views.' },
  { re: /<embed\b[^>]*>/i, message: 'Contains an `<embed>` tag — can embed remote content into rendered views.' },
  { re: /\bon(?:click|load|error|mouseover|focus)\s*=/i, message: 'Contains an inline event handler (`onclick=`, `onerror=`, …) — XSS vector.' },
  { re: /\bjavascript:\s*[a-z]/i, message: 'Contains a `javascript:` URL — XSS vector in rendered links.' },
]

// Suspicious outbound destinations. Not a reputation lookup — purely structural
// shapes that look more like attacker infrastructure than a documented service.
const SUSPICIOUS_DESTINATION_PATTERNS: Array<{ re: RegExp; message: string }> = [
  { re: /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\b/, message: 'Links to a raw IP address — bypasses DNS and reputation checks.' },
  { re: /https?:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:io|app)\b/i, message: 'Links to an ngrok tunnel — usually personal dev infrastructure, not a stable service.' },
  { re: /https?:\/\/[a-z0-9-]+\.serveo\.net\b/i, message: 'Links to a serveo tunnel — usually personal dev infrastructure.' },
  { re: /https?:\/\/[a-z0-9-]+\.localtunnel\.me\b/i, message: 'Links to a localtunnel tunnel — usually personal dev infrastructure.' },
  { re: /https?:\/\/[a-z0-9-]+\.requestbin\.com\b/i, message: 'Links to a requestbin endpoint — a tool commonly used to capture exfiltrated data.' },
  { re: /https?:\/\/[a-z0-9-]+\.webhook\.site\b/i, message: 'Links to webhook.site — a tool commonly used to capture exfiltrated data.' },
]

// Suspicious Unicode: zero-width chars, bidirectional overrides, variation
// selectors used for steganography (encoding bytes inside emojis), BOM in mid-
// content. Each is a classic "looks innocent, isn't" smell.
interface UnicodeRule {
  test: (text: string) => { idx: number; name: string } | null
  name: string
}

const SINGLE_CHAR_SUSPICIOUS: Array<{ codepoint: number; name: string }> = [
  { codepoint: 0x200b, name: 'zero-width space (U+200B)' },
  { codepoint: 0x200c, name: 'zero-width non-joiner (U+200C)' },
  { codepoint: 0x200d, name: 'zero-width joiner (U+200D)' },
  { codepoint: 0x2060, name: 'word joiner (U+2060)' },
  { codepoint: 0x202e, name: 'right-to-left override (U+202E)' },
  { codepoint: 0x202d, name: 'left-to-right override (U+202D)' },
  { codepoint: 0x2066, name: 'left-to-right isolate (U+2066)' },
  { codepoint: 0x2067, name: 'right-to-left isolate (U+2067)' },
  { codepoint: 0x2068, name: 'first-strong isolate (U+2068)' },
  { codepoint: 0x2069, name: 'pop directional isolate (U+2069)' },
  { codepoint: 0xfeff, name: 'byte-order mark / zero-width no-break space (U+FEFF)' },
]

const UNICODE_RULES: UnicodeRule[] = [
  ...SINGLE_CHAR_SUSPICIOUS.map(({ codepoint, name }): UnicodeRule => ({
    name,
    test: text => {
      const idx = text.indexOf(String.fromCodePoint(codepoint))
      return idx === -1 ? null : { idx, name }
    },
  })),
  // Variation selectors (U+FE00 – U+FE0F) and supplementary selectors
  // (U+E0100 – U+E01EF) are used to encode hidden bytes inside emojis or
  // ordinary text. One occurrence is unremarkable; runs of ≥3 are the
  // documented steganography shape.
  {
    name: 'a run of Unicode variation selectors',
    test: text => {
      const re = /[︀-️]{3,}|[\u{E0100}-\u{E01EF}]{3,}/gu
      const m = re.exec(text)
      return m ? { idx: m.index, name: 'a run of Unicode variation selectors used for steganographic encoding' } : null
    },
  },
  // Tag characters (U+E0000 block) were briefly part of Unicode and are
  // semantically invisible; any usage in skill content is suspicious.
  {
    name: 'Unicode tag characters',
    test: text => {
      const re = /[\u{E0001}-\u{E007F}]/u
      const m = re.exec(text)
      return m ? { idx: m.index, name: 'Unicode tag characters (U+E0000 block) — invisible, used for steganography' } : null
    },
  },
]

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncate(s: string, max = 80): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

// Build a list of (start,end) ranges covering fenced code blocks (``` … ```).
// Some rules want to ignore matches inside fenced code (e.g. base64 hashes
// shown as examples in docs); others deliberately scan inside (shell-exec
// recipes are most dangerous inside a fence).
function fencedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const re = /```[\s\S]*?```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length])
  }
  return ranges
}

function inAnyRange(offset: number, ranges: Array<[number, number]>): boolean {
  for (const [s, e] of ranges) {
    if (offset >= s && offset < e) return true
  }
  return false
}

// ─── Individual finders ──────────────────────────────────────────────────────

function findUrls(text: string): Finding[] {
  const out: Finding[] = []
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?]+$/, '')
    out.push({
      kind: 'url',
      severity: 'info',
      message: `Links to ${truncate(url, 60)} — verify before visiting.`,
      evidence: url,
      offset: m.index ?? 0,
    })
  }
  return out
}

function findInjections(text: string): Finding[] {
  const out: Finding[] = []
  for (const { re, message } of INJECTION_PATTERNS) {
    const m = text.match(re)
    if (m) {
      out.push({
        kind: 'prompt-injection',
        severity: 'high',
        message,
        evidence: truncate(m[0]),
        offset: m.index ?? 0,
      })
    }
  }
  return out
}

function findShell(text: string): Finding[] {
  const out: Finding[] = []
  for (const { re, message } of SHELL_PATTERNS) {
    const m = text.match(re)
    if (m) {
      out.push({
        kind: 'shell-execution',
        severity: 'high',
        message,
        evidence: truncate(m[0]),
        offset: m.index ?? 0,
      })
    }
  }
  return out
}

function findEnvVarExfil(text: string): Finding[] {
  const out: Finding[] = []
  for (const { name, re } of NAMED_ENV_VARS) {
    const m = text.match(re)
    if (m) {
      out.push({
        kind: 'env-var-exfil',
        severity: 'high',
        message: `References $${name} — a credential-shaped environment variable. Hostile skills smuggle these into outbound URLs to exfiltrate keys.`,
        evidence: truncate(m[0]),
        offset: m.index ?? 0,
      })
    }
  }
  // Generic catch-all: avoid double-firing on the named matches above by
  // dedup'ing on the (name) capture group.
  const seen = new Set(out.map(f => f.evidence.replace(/[${}]/g, '')))
  for (const m of text.matchAll(new RegExp(GENERIC_CREDENTIAL_VAR_RE.source, 'g'))) {
    const ev = m[0]
    const stripped = ev.replace(/[${}]/g, '')
    if (seen.has(stripped)) continue
    out.push({
      kind: 'env-var-exfil',
      severity: 'high',
      message: 'References a credential-shaped environment variable (matches *KEY*/*TOKEN*/*SECRET*/*PASSWORD*).',
      evidence: truncate(ev),
      offset: m.index ?? 0,
    })
    seen.add(stripped)
  }
  // process.env.X references — typically appear in code blocks but worth a
  // medium-severity flag since they're the JS-side equivalent.
  for (const m of text.matchAll(new RegExp(PROCESS_ENV_RE.source, 'g'))) {
    out.push({
      kind: 'env-var-exfil',
      severity: 'medium',
      message: `Reads an environment variable in code: ${m[0]}.`,
      evidence: truncate(m[0]),
      offset: m.index ?? 0,
    })
  }
  return out
}

function findMarkdownExfil(text: string): Finding[] {
  const out: Finding[] = []
  const imgMatch = text.match(MARKDOWN_IMAGE_QUERY_RE)
  if (imgMatch) {
    out.push({
      kind: 'markdown-exfil',
      severity: 'high',
      message: 'Markdown image URL contains query parameters — when an agent renders the body, the request fires automatically (zero-click data exfiltration).',
      evidence: truncate(imgMatch[0]),
      offset: imgMatch.index ?? 0,
    })
  }
  const linkMatch = text.match(MARKDOWN_LINK_EXFIL_RE)
  if (linkMatch) {
    out.push({
      kind: 'markdown-exfil',
      severity: 'high',
      message: 'Markdown link URL contains a credential keyword or template variable — known one-click exfiltration shape.',
      evidence: truncate(linkMatch[0]),
      offset: linkMatch.index ?? 0,
    })
  }
  return out
}

function findConditionalActivation(text: string): Finding[] {
  const out: Finding[] = []
  for (const { re, message } of CONDITIONAL_ACTIVATION_PATTERNS) {
    const m = text.match(re)
    if (m) {
      out.push({
        kind: 'conditional-activation',
        severity: 'high',
        message,
        evidence: truncate(m[0]),
        offset: m.index ?? 0,
      })
    }
  }
  return out
}

function findEmbeddedBase64(text: string): Finding[] {
  const fences = fencedRanges(text)
  const out: Finding[] = []
  for (const m of text.matchAll(BASE64_RE)) {
    const offset = m.index ?? 0
    // Skip matches inside fenced code — they're commonly real hashes or
    // documented examples, not stashed payloads.
    if (inAnyRange(offset, fences)) continue
    out.push({
      kind: 'embedded-base64',
      severity: 'medium',
      message: `Embedded base64 sequence (≥48 chars) outside code blocks — often used to hide instructions or credentials.`,
      evidence: truncate(m[0], 60),
      offset,
    })
  }
  return out
}

function findHtmlInjection(text: string): Finding[] {
  const out: Finding[] = []
  for (const { re, message } of HTML_INJECTION_PATTERNS) {
    const m = text.match(re)
    if (m) {
      out.push({
        kind: 'html-injection',
        severity: 'high',
        message,
        evidence: truncate(m[0]),
        offset: m.index ?? 0,
      })
    }
  }
  return out
}

function findSuspiciousDestinations(text: string): Finding[] {
  const out: Finding[] = []
  for (const { re, message } of SUSPICIOUS_DESTINATION_PATTERNS) {
    const m = text.match(re)
    if (m) {
      out.push({
        kind: 'suspicious-destination',
        severity: 'medium',
        message,
        evidence: truncate(m[0]),
        offset: m.index ?? 0,
      })
    }
  }
  return out
}

function findSuspiciousUnicode(text: string): Finding[] {
  const out: Finding[] = []
  for (const rule of UNICODE_RULES) {
    const hit = rule.test(text)
    if (hit) {
      out.push({
        kind: 'suspicious-unicode',
        severity: 'medium',
        message: `Contains ${hit.name}, sometimes used to hide content from a reviewer's eye.`,
        evidence: hit.name,
        offset: hit.idx,
      })
    }
  }
  return out
}

// Combination rule: env-var-exfil + conditional-activation in the same skill is
// the ClawHavoc shape. Emit a single high-severity finding pointing at both so
// reviewers see the most informative thing first.
function findCombos(findings: Finding[]): Finding[] {
  const hasEnvVar = findings.some(f => f.kind === 'env-var-exfil' && f.severity === 'high')
  const hasConditional = findings.some(f => f.kind === 'conditional-activation')
  if (!hasEnvVar || !hasConditional) return []
  const envFinding = findings.find(f => f.kind === 'env-var-exfil')!
  return [{
    kind: 'combo-exfil',
    severity: 'high',
    message: 'CRITICAL pattern: this skill references a credential-shaped env var AND uses conditional-activation language. This combination matches the documented ClawHavoc / ToxicSkills malicious-skill shape — do not enable without review.',
    evidence: envFinding.evidence,
    offset: envFinding.offset,
  }]
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, info: 2 }
const KIND_RANK: Record<FindingKind, number> = {
  'combo-exfil': 0,
  'env-var-exfil': 1,
  'markdown-exfil': 2,
  'conditional-activation': 3,
  'prompt-injection': 4,
  'shell-execution': 5,
  'html-injection': 6,
  'suspicious-destination': 7,
  'embedded-base64': 8,
  'suspicious-unicode': 9,
  'url': 10,
}

export function scanContent(text: string): Finding[] {
  if (!text) return []
  const findings = [
    ...findInjections(text),
    ...findShell(text),
    ...findEnvVarExfil(text),
    ...findMarkdownExfil(text),
    ...findConditionalActivation(text),
    ...findEmbeddedBase64(text),
    ...findHtmlInjection(text),
    ...findSuspiciousDestinations(text),
    ...findSuspiciousUnicode(text),
    ...findUrls(text),
  ]
  findings.push(...findCombos(findings))
  // Stable order: severity, then category rank (combo first, URL last), then
  // offset. Makes the scariest item the first thing the reader sees.
  findings.sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (sev !== 0) return sev
    const kind = KIND_RANK[a.kind] - KIND_RANK[b.kind]
    if (kind !== 0) return kind
    return a.offset - b.offset
  })
  return findings
}

export interface ScanSummary {
  total: number
  high: number
  medium: number
  info: number
}

export function summarize(findings: Finding[]): ScanSummary {
  return {
    total: findings.length,
    high: findings.filter(f => f.severity === 'high').length,
    medium: findings.filter(f => f.severity === 'medium').length,
    info: findings.filter(f => f.severity === 'info').length,
  }
}

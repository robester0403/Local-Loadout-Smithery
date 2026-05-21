// Pattern-based security scanner for skill content. Defense-in-depth: catches
// the obvious stuff a hostile or careless author might ship in a SKILL.md /
// AGENTS.md / command body. Not a substitute for review — just a tripwire.

export type Severity = 'info' | 'medium' | 'high'

export type FindingKind =
  | 'url'
  | 'prompt-injection'
  | 'shell-execution'
  | 'suspicious-unicode'

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

// Prompt-injection markers. These don't catch sophisticated attacks but they
// flag the lazy obvious ones — "ignore previous instructions", system-role
// spoofs, the assistant prefix.
const INJECTION_PATTERNS: Array<{ re: RegExp; message: string }> = [
  { re: /ignore (?:all )?(?:previous|prior|above) instructions?/i, message: 'Contains a prompt-injection trigger ("ignore previous instructions").' },
  { re: /disregard (?:all )?(?:previous|prior|above) instructions?/i, message: 'Contains a prompt-injection trigger ("disregard previous instructions").' },
  { re: /you are now (?:a |an )?(?:[a-z ]{2,40})\b/i, message: 'Contains a role-override pattern ("you are now …").' },
  { re: /<\|im_(?:start|end)\|>/i, message: 'Contains ChatML role tokens used to spoof system/assistant turns.' },
  { re: /\n\s*system\s*:\s/i, message: 'Contains a "system:" role marker that may be interpreted as a higher-priority instruction.' },
  { re: /\n\s*assistant\s*:\s/i, message: 'Contains an "assistant:" role marker that may spoof a model response.' },
  { re: /BEGIN\s+SYSTEM\s+PROMPT/i, message: 'Contains a "BEGIN SYSTEM PROMPT" delimiter often used for injection.' },
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

// Suspicious Unicode: zero-width chars, right-to-left override, BOM in the
// middle of content. Each of these is a classic "looks innocent, isn't" smell.
const SUSPICIOUS_UNICODE: Array<{ codepoint: number; name: string }> = [
  { codepoint: 0x200b, name: 'zero-width space (U+200B)' },
  { codepoint: 0x200c, name: 'zero-width non-joiner (U+200C)' },
  { codepoint: 0x200d, name: 'zero-width joiner (U+200D)' },
  { codepoint: 0x2060, name: 'word joiner (U+2060)' },
  { codepoint: 0x202e, name: 'right-to-left override (U+202E)' },
  { codepoint: 0xfeff, name: 'byte-order mark / zero-width no-break space (U+FEFF)' },
]

function truncate(s: string, max = 80): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

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

function findSuspiciousUnicode(text: string): Finding[] {
  const out: Finding[] = []
  for (const { codepoint, name } of SUSPICIOUS_UNICODE) {
    const idx = text.indexOf(String.fromCodePoint(codepoint))
    if (idx !== -1) {
      out.push({
        kind: 'suspicious-unicode',
        severity: 'medium',
        message: `Contains ${name}, sometimes used to hide content from a reviewer's eye.`,
        evidence: name,
        offset: idx,
      })
    }
  }
  return out
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, info: 2 }

export function scanContent(text: string): Finding[] {
  if (!text) return []
  const findings = [
    ...findInjections(text),
    ...findShell(text),
    ...findSuspiciousUnicode(text),
    ...findUrls(text),
  ]
  // Stable order: severity descending, then offset ascending. Makes the UI
  // surface the scariest item first regardless of where it sits in the file.
  findings.sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    return sev !== 0 ? sev : a.offset - b.offset
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

// Rule layer types. All security rules — in-house, lifted from LLM Guard,
// from MITRE ATLAS mappings, future — share this contract so the orchestrator
// in scan.ts doesn't care where the rule came from.

export type Severity = 'info' | 'medium' | 'high'

// Known kinds. Extend the union when adding a fundamentally new category of
// finding (the UI groups by kind). Adding a rule to an existing kind doesn't
// require a type change.
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
  | 'leaked-secret'
  | 'combo-exfil'

export interface Finding {
  // Stable rule id (e.g. `prompt-injection.ignore-previous`). Lets the UI
  // and (future) per-skill ignore lists key on something stable across
  // wording tweaks to the human-readable message.
  ruleId: string
  kind: FindingKind
  severity: Severity
  message: string
  // The matched substring, truncated for UI display.
  evidence: string
  // Zero-based offset of the match in the scanned text.
  offset: number
  // Optional provenance — where the detection pattern came from. Powers the
  // "why is this flagged" audit story.
  source?: string
  // Optional MITRE ATLAS technique mapping (e.g. AML.T0051.000).
  atlasId?: string
}

// Context passed to every rule. Memoized work (fence ranges, lower-cased
// text, etc.) is computed once per scan and reused so rule packs don't each
// pay for it.
export interface ScanContext {
  text: string
  // Inclusive-exclusive [start, end) ranges for ``` … ``` fenced code blocks.
  // Rules that should ignore matches inside fenced code use `inFence(ctx, idx)`.
  fencedRanges: Array<[number, number]>
}

// A single rule. Each rule is responsible for ONE detection idea — a regex,
// a unicode codepoint, a substring check. Bundling multiple regexes into one
// rule is fine when they share severity + message intent (see envVarExfil's
// named-var list); split into separate rules when severity or message differs.
export interface Rule {
  id: string
  kind: FindingKind
  severity: Severity
  // Where this rule came from. Free-form string — but use a stable identifier
  // like `in-house`, `llm-guard@0.3.16`, `detect-secrets@1.5.0`, or
  // `mitre-atlas:AML.T0051.000` so audits can group by source.
  source: string
  // Optional MITRE ATLAS technique id (separate from `source` because a rule
  // may be in-house but still map to an ATLAS technique).
  atlasId?: string
  // Optional gate — return false to skip this rule for a given scan. Used to
  // disable rules for specific contexts (none used yet; the hook is here for
  // future per-skill ignore-lists).
  enabled?: (ctx: ScanContext) => boolean
  check: (ctx: ScanContext) => Finding[]
}

// A pack groups related rules so they can be added/removed as a unit and
// share metadata. Each file under `rules/` exports one pack.
export interface RulePack {
  id: string
  description: string
  source: string
  rules: Rule[]
}

// Helpers shared by rule implementations — exported so packs don't duplicate.

export function truncate(s: string, max = 80): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

export function inFence(ctx: ScanContext, offset: number): boolean {
  for (const [s, e] of ctx.fencedRanges) {
    if (offset >= s && offset < e) return true
  }
  return false
}

// Build a Finding from a regex match — common enough that every rule pack
// would otherwise reimplement it.
export function findingFromMatch(
  rule: Pick<Rule, 'id' | 'kind' | 'severity' | 'source' | 'atlasId'>,
  match: RegExpMatchArray | RegExpExecArray,
  message: string,
  evidence?: string,
): Finding {
  return {
    ruleId: rule.id,
    kind: rule.kind,
    severity: rule.severity,
    message,
    evidence: truncate(evidence ?? match[0]),
    offset: match.index ?? 0,
    source: rule.source,
    atlasId: rule.atlasId,
  }
}

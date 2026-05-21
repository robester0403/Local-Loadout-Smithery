// Security scanner orchestrator. Pluggable: every rule lives in its own
// file under ./rules/, registered in PACKS below. Combinations consume
// findings from multiple packs and live in ./combinations.ts.
//
// To add a rule:   edit the relevant rule pack (or create a new one and
//                  register it in PACKS below).
// To remove a rule: delete it from its pack.
// To disable a rule at runtime: add an `enabled` predicate that returns false.

import type { Finding, FindingKind, RulePack, ScanContext, Severity } from './types'
import { detectCombinations } from './combinations'

import { pack as urls } from './rules/urls'
import { pack as promptInjection } from './rules/promptInjection'
import { pack as shellExecution } from './rules/shellExecution'
import { pack as envVarExfil } from './rules/envVarExfil'
import { pack as markdownExfil } from './rules/markdownExfil'
import { pack as conditionalActivation } from './rules/conditionalActivation'
import { pack as embeddedBase64 } from './rules/embeddedBase64'
import { pack as htmlInjection } from './rules/htmlInjection'
import { pack as suspiciousDestination } from './rules/suspiciousDestination'
import { pack as suspiciousUnicode } from './rules/suspiciousUnicode'
import { pack as leakedSecret } from './rules/secrets'

// Single source of truth for what runs. Order doesn't matter (results are
// sorted at the end), but keeping high-severity packs near the top makes
// the registry easy to scan visually.
export const PACKS: RulePack[] = [
  leakedSecret,
  envVarExfil,
  markdownExfil,
  conditionalActivation,
  promptInjection,
  shellExecution,
  htmlInjection,
  suspiciousDestination,
  embeddedBase64,
  suspiciousUnicode,
  urls,
]

export type { Finding, FindingKind, Severity, RulePack } from './types'
export { PACKS as ALL_PACKS }

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, info: 2 }
const KIND_RANK: Record<FindingKind, number> = {
  'combo-exfil': 0,
  'leaked-secret': 1,
  'env-var-exfil': 2,
  'markdown-exfil': 3,
  'conditional-activation': 4,
  'prompt-injection': 5,
  'shell-execution': 6,
  'html-injection': 7,
  'suspicious-destination': 8,
  'embedded-base64': 9,
  'suspicious-unicode': 10,
  url: 11,
}

function buildContext(text: string): ScanContext {
  const fencedRanges: Array<[number, number]> = []
  const re = /```[\s\S]*?```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    fencedRanges.push([m.index, m.index + m[0].length])
  }
  return { text, fencedRanges }
}

export function scanContent(text: string): Finding[] {
  if (!text) return []
  const ctx = buildContext(text)

  const findings: Finding[] = []
  for (const pack of PACKS) {
    for (const rule of pack.rules) {
      if (rule.enabled && !rule.enabled(ctx)) continue
      try {
        findings.push(...rule.check(ctx))
      } catch (err) {
        // A broken rule must not take down the scan. Swallow + log; rule
        // owner will see the test failure in CI.
        // eslint-disable-next-line no-console
        console.error(`[security] rule ${rule.id} threw:`, err)
      }
    }
  }

  findings.push(...detectCombinations(findings))

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

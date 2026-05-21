// Cross-pack rules. Each combination consumes findings produced by individual
// rule packs and emits a higher-priority finding when a documented attack
// shape is present. Add a new combination = add an entry to COMBOS below.

import type { Finding } from './types'

export interface Combination {
  id: string
  description: string
  source: string
  // Returns zero or one extra finding. The combo finding inherits the offset
  // from one of the inputs so the UI can scroll to a meaningful location.
  detect: (findings: Finding[]) => Finding | null
}

const clawHavoc: Combination = {
  id: 'combo.claw-havoc',
  description: 'Env-var reference + conditional-activation language in the same skill = the documented ClawHavoc shape.',
  source: 'ToxicSkills research',
  detect: findings => {
    const env = findings.find(f => f.kind === 'env-var-exfil' && f.severity === 'high')
    const conditional = findings.find(f => f.kind === 'conditional-activation')
    if (!env || !conditional) return null
    return {
      ruleId: 'combo.claw-havoc',
      kind: 'combo-exfil',
      severity: 'high',
      message: 'CRITICAL pattern: this skill references a credential-shaped env var AND uses conditional-activation language. This combination matches the documented ClawHavoc / ToxicSkills malicious-skill shape — do not enable without review.',
      evidence: env.evidence,
      offset: Math.min(env.offset, conditional.offset),
      source: 'ToxicSkills research',
    }
  },
}

const leakedSecretWithExfil: Combination = {
  id: 'combo.secret-and-exfil-target',
  description: 'A literal leaked credential plus an outbound URL with template var / suspicious destination — active leak in progress.',
  source: 'in-house',
  detect: findings => {
    const secret = findings.find(f => f.kind === 'leaked-secret')
    const exfilTarget = findings.find(f =>
      f.kind === 'markdown-exfil' || f.kind === 'suspicious-destination',
    )
    if (!secret || !exfilTarget) return null
    return {
      ruleId: 'combo.secret-and-exfil-target',
      kind: 'combo-exfil',
      severity: 'high',
      message: 'CRITICAL pattern: this skill contains a literal credential AND points at a suspicious outbound destination. Rotate the credential and treat the skill as hostile.',
      evidence: secret.evidence,
      offset: Math.min(secret.offset, exfilTarget.offset),
      source: 'in-house',
    }
  },
}

export const COMBOS: Combination[] = [clawHavoc, leakedSecretWithExfil]

export function detectCombinations(findings: Finding[]): Finding[] {
  const out: Finding[] = []
  for (const combo of COMBOS) {
    const finding = combo.detect(findings)
    if (finding) out.push(finding)
  }
  return out
}

// Public surface of the prompts module.
//
// Per-issue prompt builders (fixHealth, fixRemovalCandidate, etc.) are
// imported directly from their files by the badge / drawer components.
// Only the multi-skill bundler is consumed through this barrel.

import type { Skill } from '../types'

export function getBundledPrompt(skills: Skill[]): string {
  const items = skills.map((skill, i) => {
    const issues: string[] = []
    if (skill.health.status !== 'ok') {
      skill.health.issues.forEach(iss => issues.push(`[${iss.severity}] ${iss.message}`))
    }
    if (skill.insight === 'removal-candidate') issues.push('[insight] Removal candidate — loaded but never invoked')
    if (skill.dormant) issues.push('[insight] Dormant — not invoked in 90+ days')
    return `${i + 1}. **${skill.name}** (${skill.type}) — ${skill.path}\n${issues.map(s => `   - ${s}`).join('\n')}`
  }).join('\n\n')

  return `## Context
${skills.length} skills need attention:

${items}

## Task
Address every issue for each skill above. For each one:
- Fix health issues (description, scope, tools declarations)
- Remove or improve dormant/removal-candidate skills based on whether they still earn their keep
- Commit fixes per skill with descriptive messages

## Constraints
- Work through them sequentially — confirm each fix before moving on
- Preserve all body logic unless the body itself is broken
- Don't leave any skill in the same broken state it started in`
}

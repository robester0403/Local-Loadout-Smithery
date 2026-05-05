import type { Skill } from '../types'
import { generateFixHealthPrompt } from './fixHealthPrompt'
import { generateFixRemovalCandidatePrompt } from './fixRemovalCandidatePrompt'
import { generateFixDormantPrompt } from './fixDormantPrompt'
import { generateFixDescriptionQualityPrompt } from './fixDescriptionQualityPrompt'
import { generateFixScopeMismatchPrompt } from './fixScopeMismatchPrompt'
export { generateReclassifyPrompt } from './reclassifyPrompt'

export type PromptKey = 'health' | 'removal-candidate' | 'dormant' | 'description-quality' | 'scope-mismatch'

export function getFixPrompt(key: PromptKey, skill: Skill): string {
  switch (key) {
    case 'health': return generateFixHealthPrompt(skill)
    case 'removal-candidate': return generateFixRemovalCandidatePrompt(skill)
    case 'dormant': return generateFixDormantPrompt(skill)
    case 'description-quality': return generateFixDescriptionQualityPrompt(skill)
    case 'scope-mismatch': return generateFixScopeMismatchPrompt(skill)
  }
}

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

export async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}

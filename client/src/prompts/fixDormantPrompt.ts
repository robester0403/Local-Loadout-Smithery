import type { Skill } from '../types'

export function generateFixDormantPrompt(skill: Skill): string {
  const lastUsed = skill.lastInvoked
    ? `Last invoked: ${new Date(skill.lastInvoked).toLocaleDateString()}`
    : 'Never invoked'
  return `## Context
Skill: **${skill.name}** (${skill.type})
Path: ${skill.path}
Description: "${skill.description || '(none)'}"
${lastUsed} — dormant for 90+ days

## Task
Review and act on this dormant skill:
1. Still relevant but forgotten? → Check if the description is discoverable; improve if not
2. Replaced by a newer skill? → Delete this one: rm "${skill.path}"
3. Body is outdated? → Update it or delete it

## Constraints
- "Dormant" means either unused or superseded — don't just leave it
- If improving, keep description ≤150 chars starting with an imperative verb
- If deleting, check for references in other skills or CLAUDE.md files first`
}

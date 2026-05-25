import type { Skill } from '../types'

export function generateFixRemovalCandidatePrompt(skill: Skill): string {
  return `## Context
Skill: **${skill.name}** (${skill.type})
Path: ${skill.path}
Description: "${skill.description || '(none)'}"
Loaded tokens: ${skill.loadedTokens} per turn — Invocations: ${skill.invocations}
This skill pays a context tax on every turn but has never been invoked.

## Task
Decide and act — do not leave it in its current state:
1. If genuinely useful but undiscovered → improve the description so it's easier to trigger
2. If superseded by another skill → delete it: rm "${skill.path}"
3. If experimental / incomplete → either finish it or delete it

## Constraints
- Be decisive. A skill that never gets invoked costs more than it earns
- If deleting, verify no other files reference it by name
- If improving the description, keep it under 150 chars and start with an imperative verb`
}

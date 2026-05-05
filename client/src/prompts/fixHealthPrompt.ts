import type { Skill } from '../types'

export function generateFixHealthPrompt(skill: Skill): string {
  const issues = skill.health.issues.map(i => `- [${i.severity}] ${i.message}`).join('\n')
  return `## Context
Skill: **${skill.name}** (${skill.type})
Path: ${skill.path}
Description: "${skill.description || '(none)'}"
Health issues:
${issues}

## Task
Fix every health issue listed above. Common fixes:
- Missing description → add a concise ≤150-char description starting with an imperative verb
- No action verb → rewrite description to open with Analyze / Generate / Run / Detect / etc.
- Duplicate description → make it unique and specific to this skill's actual purpose
- Missing allowed-tools → add a \`tools:\` frontmatter array listing tools the body references
- Scope mismatch → verify this skill belongs in its current directory (global vs project-local)

## Constraints
- Edit only frontmatter or the first few lines of the body where strictly necessary
- Preserve all existing body logic
- Commit with: fix(${skill.name}): resolve health issues`
}

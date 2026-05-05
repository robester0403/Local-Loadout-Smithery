import type { Skill } from '../types'

export function generateFixDescriptionQualityPrompt(skill: Skill): string {
  const issues = skill.health.issues
    .filter(i => i.message.toLowerCase().includes('description') || i.message.toLowerCase().includes('action verb'))
    .map(i => `- ${i.message}`)
    .join('\n') || '- Description quality issue'
  return `## Context
Skill: **${skill.name}** (${skill.type})
Path: ${skill.path}
Current description (${skill.descLen} chars): "${skill.description || '(none)'}"
Issues:
${issues}

## Task
Rewrite the \`description:\` frontmatter field so it:
- Opens with an imperative verb (Analyze, Generate, Run, Detect, Summarize, etc.)
- Clearly states the trigger condition — when would you invoke this?
- Stays under 150 characters total

## Constraints
- Edit only the \`description:\` field in frontmatter
- Do not touch the skill body
- Target: one tight sentence, action-oriented, discoverable`
}

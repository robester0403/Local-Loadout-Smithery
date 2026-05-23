import type { Skill } from '../types'

// Derive the account directory from the skill's path + type so the prompt
// references the right root (~/.claude, ~/.cursor, etc.) regardless of ecosystem.
function accountDirFromPath(skillPath: string, skillType: string): string {
  const depth = skillType === 'skill' ? 3 : 2
  const segments = skillPath.split('/')
  return segments.slice(0, segments.length - depth).join('/')
}

export function generateReclassifyPrompt(skill: Skill): string {
  const suggested = skill.suggestedType?.suggested ?? 'command'
  const cues = skill.suggestedType?.cues ?? []
  const accountDir = accountDirFromPath(skill.path, skill.type)

  return `## Context
Skill: **${skill.name}** (currently classified as: ${skill.type})
Path: ${skill.path}
Suggested reclassification: ${suggested}
Signals that triggered this:
${cues.map(c => `- ${c}`).join('\n')}

## Task
1. Read the file at \`${skill.path}\`
2. Decide if reclassifying \`${skill.type}\` → \`${suggested}\` is correct based on the signals above
3. If yes: move the file to the appropriate directory
   - Skills: \`${accountDir}/skills/<name>/SKILL.md\`
   - Commands: \`${accountDir}/commands/<name>.md\`
   - Subagents: \`${accountDir}/agents/<name>.md\`
4. Update the frontmatter \`type\` field if present
5. If no: explain what in the body justifies keeping the current classification

## Constraints
- Do not modify body content unless there is a genuine content issue
- If the source was in a skill directory (skills/<name>/SKILL.md), check if the directory can be removed after the move
- Preserve all frontmatter fields — only update \`type\` if it was already set
- Confirm the destination file exists after moving
- If unsure which classification is correct, ask rather than guessing`
}

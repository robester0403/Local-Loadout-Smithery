import type { Skill } from '../types'

export function generateFixScopeMismatchPrompt(skill: Skill): string {
  const issues = skill.health.issues
    .filter(i => i.message.toLowerCase().includes('scope'))
    .map(i => `- ${i.message}`)
    .join('\n') || '- Scope mismatch detected'
  const targetScope = skill.scope === 'global'
    ? 'project-local (.claude/skills/ or .claude/commands/ inside the relevant repo)'
    : 'global (~/.claude/skills/ or ~/.claude/commands/)'
  return `## Context
Skill: **${skill.name}** (${skill.type})
Path: ${skill.path}
Current scope: ${skill.scope}
Issues:
${issues}

## Task
Move this skill to the correct scope. Signals suggest it belongs in ${targetScope}.

Steps:
1. Determine the correct destination path
2. mv "${skill.path}" <destination>
3. If the skill was symlinked, update the symlink target instead
4. Verify Claude Code picks it up: claude --print "list skills" | grep ${skill.name}

## Constraints
- Global skills: reusable across all projects, no project-specific paths or env vars
- Project-local: tied to one repo, may reference repo-specific conventions
- After moving, check ~/.claude/projects/ for any stale project-scoped copies`
}

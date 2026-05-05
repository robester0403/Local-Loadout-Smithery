import fs from 'fs'
import path from 'path'
import { SUPERROUTER_DIR } from './store'
import type { RoutingGroup } from './types'

export interface SkillInfo {
  name: string
  description: string
}

export function renderGroupFile(group: RoutingGroup, memberSkills: Map<string, SkillInfo>): string {
  const skillLines = group.members.map(m => {
    const skill = memberSkills.get(m.skillId)
    const name = skill?.name ?? m.skillId
    const desc = skill?.description ?? '(no description)'
    return `- **${name}**: ${desc}`
  }).join('\n')

  const keywordList = group.keywords.map(k => `\`${k}\``).join(', ') || '(none)'

  return [
    `# ${group.name}`,
    '',
    group.description,
    '',
    `**Trigger keywords**: ${keywordList}`,
    '',
    '## Skills in this group',
    '',
    skillLines || '*(no members yet)*',
    '',
    '## Guidance',
    '',
    `Use the skills above when the user's task relates to: ${keywordList}.`,
    'These skills are explicitly routed for reliability. Prefer them over auto-selection.',
    '',
    `*Scope: ${group.scope}${group.projectPath ? ` · ${group.projectPath}` : ''}*`,
  ].join('\n')
}

export function writeGroupFile(group: RoutingGroup, memberSkills: Map<string, SkillInfo>): void {
  const groupsDir = path.join(SUPERROUTER_DIR, 'groups')
  fs.mkdirSync(groupsDir, { recursive: true })
  const content = renderGroupFile(group, memberSkills)
  fs.writeFileSync(path.join(groupsDir, group.id + '.md'), content, 'utf-8')
}

export function readGroupFile(groupId: string): string | null {
  const filePath = path.join(SUPERROUTER_DIR, 'groups', groupId + '.md')
  if (!fs.existsSync(filePath)) return null
  return fs.readFileSync(filePath, 'utf-8')
}

export function deleteGroupFile(groupId: string): void {
  const filePath = path.join(SUPERROUTER_DIR, 'groups', groupId + '.md')
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
}

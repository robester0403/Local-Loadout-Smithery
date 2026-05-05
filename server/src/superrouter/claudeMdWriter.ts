import fs from 'fs'
import path from 'path'
import os from 'os'
import type { RoutingGroup } from './types'
import { readGroupFile } from './routingFile'

const START_MARKER = '<!-- LSM:SUPERROUTER-START -->'
const END_MARKER = '<!-- LSM:SUPERROUTER-END -->'

function buildManagedContent(enabledGroups: RoutingGroup[]): string {
  const sections = enabledGroups
    .map(g => readGroupFile(g.id) ?? `# ${g.name}\n\n${g.description}`)
    .join('\n\n---\n\n')

  return [
    '',
    '## Skill Routing — SuperRouter (managed by Local Skill Manager)',
    '',
    sections || '*(no groups enabled)*',
    '',
    `*Auto-updated by LSM on ${new Date().toISOString().split('T')[0]}. Edit groups via the SuperRouter tab.*`,
    '',
  ].join('\n')
}

export function writeManagedBlock(claudeMdPath: string, content: string): void {
  fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true })

  const existing = fs.existsSync(claudeMdPath)
    ? fs.readFileSync(claudeMdPath, 'utf-8')
    : ''

  const startIdx = existing.indexOf(START_MARKER)
  const endIdx = existing.indexOf(END_MARKER)

  let updated: string
  if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
    // Replace content between existing markers
    updated =
      existing.slice(0, startIdx) +
      START_MARKER +
      content +
      END_MARKER +
      existing.slice(endIdx + END_MARKER.length)
  } else {
    // Append block; clean up any orphaned start marker
    const cleaned = existing.replace(new RegExp(START_MARKER + '[\\s\\S]*$'), '').trimEnd()
    updated = (cleaned ? cleaned + '\n\n' : '') + START_MARKER + content + END_MARKER + '\n'
  }

  const tmp = claudeMdPath + '.lsm-tmp'
  fs.writeFileSync(tmp, updated, 'utf-8')
  fs.renameSync(tmp, claudeMdPath)
}

export function removeManagedBlock(claudeMdPath: string): void {
  if (!fs.existsSync(claudeMdPath)) return
  const content = fs.readFileSync(claudeMdPath, 'utf-8')
  const startIdx = content.indexOf(START_MARKER)
  if (startIdx === -1) return

  const endIdx = content.indexOf(END_MARKER)
  let updated: string
  if (endIdx !== -1 && startIdx < endIdx) {
    updated = (content.slice(0, startIdx) + content.slice(endIdx + END_MARKER.length)).trimEnd() + '\n'
  } else {
    // Malformed — strip from START_MARKER onward
    updated = content.slice(0, startIdx).trimEnd() + '\n'
  }

  const tmp = claudeMdPath + '.lsm-tmp'
  fs.writeFileSync(tmp, updated, 'utf-8')
  fs.renameSync(tmp, claudeMdPath)
}

export function updateGlobalClaude(enabledGlobalGroups: RoutingGroup[]): void {
  const claudeMdPath = path.join(os.homedir(), '.claude', 'CLAUDE.md')
  if (enabledGlobalGroups.length === 0) {
    removeManagedBlock(claudeMdPath)
  } else {
    writeManagedBlock(claudeMdPath, buildManagedContent(enabledGlobalGroups))
  }
}

export function updateProjectClaude(projectPath: string, enabledProjectGroups: RoutingGroup[]): void {
  const claudeMdPath = path.join(projectPath, 'CLAUDE.md')
  if (enabledProjectGroups.length === 0) {
    removeManagedBlock(claudeMdPath)
  } else {
    writeManagedBlock(claudeMdPath, buildManagedContent(enabledProjectGroups))
  }
}

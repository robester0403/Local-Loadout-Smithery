import fs from 'fs'
import path from 'path'
import os from 'os'
import type { RoutingGroup } from './types'
import { readGroupFile } from './routingFile'

const START_MARKER = '<!-- LOADOUTSMITH:SUPERROUTER-START -->'
const END_MARKER = '<!-- LOADOUTSMITH:SUPERROUTER-END -->'
// Recognize legacy markers from the pre-rename era so existing CLAUDE.md
// files continue to be managed instead of getting a duplicate block appended.
const LEGACY_START_MARKER = '<!-- LSM:SUPERROUTER-START -->'
const LEGACY_END_MARKER = '<!-- LSM:SUPERROUTER-END -->'

function buildManagedContent(enabledGroups: RoutingGroup[]): string {
  const sections = enabledGroups
    .map(g => readGroupFile(g.id) ?? `# ${g.name}\n\n${g.description}`)
    .join('\n\n---\n\n')

  return [
    '',
    '## Skill Routing — SuperRouter (managed by Local Loadout Smithery)',
    '',
    sections || '*(no groups enabled)*',
    '',
    `*Auto-updated by Local Loadout Smithery on ${new Date().toISOString().split('T')[0]}. Edit groups via the SuperRouter tab.*`,
    '',
  ].join('\n')
}

// Find an existing managed block, preferring current markers but falling back
// to legacy LSM markers so pre-rename CLAUDE.md files migrate seamlessly.
function findMarkers(text: string): { start: number; end: number; startMarker: string; endMarker: string } | null {
  const startIdx = text.indexOf(START_MARKER)
  const endIdx = text.indexOf(END_MARKER)
  if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
    return { start: startIdx, end: endIdx, startMarker: START_MARKER, endMarker: END_MARKER }
  }
  const legacyStart = text.indexOf(LEGACY_START_MARKER)
  const legacyEnd = text.indexOf(LEGACY_END_MARKER)
  if (legacyStart !== -1 && legacyEnd !== -1 && legacyStart < legacyEnd) {
    return { start: legacyStart, end: legacyEnd, startMarker: LEGACY_START_MARKER, endMarker: LEGACY_END_MARKER }
  }
  return null
}

export function writeManagedBlock(claudeMdPath: string, content: string): void {
  fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true })

  const existing = fs.existsSync(claudeMdPath)
    ? fs.readFileSync(claudeMdPath, 'utf-8')
    : ''

  const found = findMarkers(existing)

  let updated: string
  if (found) {
    // Replace content between existing markers and migrate them to current names.
    updated =
      existing.slice(0, found.start) +
      START_MARKER +
      content +
      END_MARKER +
      existing.slice(found.end + found.endMarker.length)
  } else {
    // Append block; clean up any orphaned start marker (current or legacy).
    let cleaned = existing
      .replace(new RegExp(START_MARKER + '[\\s\\S]*$'), '')
      .replace(new RegExp(LEGACY_START_MARKER + '[\\s\\S]*$'), '')
      .trimEnd()
    updated = (cleaned ? cleaned + '\n\n' : '') + START_MARKER + content + END_MARKER + '\n'
  }

  const tmp = claudeMdPath + '.loadoutsmith-tmp'
  fs.writeFileSync(tmp, updated, 'utf-8')
  fs.renameSync(tmp, claudeMdPath)
}

export function removeManagedBlock(claudeMdPath: string): void {
  if (!fs.existsSync(claudeMdPath)) return
  const content = fs.readFileSync(claudeMdPath, 'utf-8')
  const found = findMarkers(content)
  if (!found) {
    // Maybe an orphan start marker (no matching end). Strip it from there onward.
    const orphanStart =
      content.indexOf(START_MARKER) !== -1
        ? content.indexOf(START_MARKER)
        : content.indexOf(LEGACY_START_MARKER)
    if (orphanStart === -1) return
    const stripped = content.slice(0, orphanStart).trimEnd() + '\n'
    const tmp = claudeMdPath + '.loadoutsmith-tmp'
    fs.writeFileSync(tmp, stripped, 'utf-8')
    fs.renameSync(tmp, claudeMdPath)
    return
  }

  const updated =
    (content.slice(0, found.start) + content.slice(found.end + found.endMarker.length)).trimEnd() + '\n'

  const tmp = claudeMdPath + '.loadoutsmith-tmp'
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

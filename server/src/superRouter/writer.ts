import fs from 'fs'
import path from 'path'
import type { Skill } from '../scanner/types'
import type { Bundle, BundleSkillEntry } from './types'
import { resolveBundlePaths } from './paths'

// A resolved row for the map: the bundle's per-skill entry paired with the
// live Skill record. Both come in so the writer doesn't have to re-query.
export interface ResolvedSkillRow {
  entry: BundleSkillEntry
  skill: Skill
}

const HEADER = '<!-- super-router:'

export function startMarker(id: string): string {
  return `${HEADER}${id} start -->`
}
export function endMarker(id: string): string {
  return `${HEADER}${id} end -->`
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function blockRegex(id: string): RegExp {
  return new RegExp(
    `\\n?${escapeRegex(startMarker(id))}[\\s\\S]*?${escapeRegex(endMarker(id))}\\n?`,
    'g',
  )
}

// Matches any super-router trigger block, regardless of bundle id. Used by
// discovery's shadow-edit detection so the marker block injected into
// CLAUDE.md / AGENTS.md / Cursor MD doesn't count as a user-side edit.
// SuperRouter's own drift detection (LOC-23) covers changes inside the
// block; this strip only affects the comparison against the user-content
// baseline.
const ANY_BLOCK_PATTERN =
  /\n?<!-- super-router:[^>\n]*? start -->[\s\S]*?<!-- super-router:[^>\n]*? end -->\n?/g

export function stripSuperRouterBlocks(content: string): string {
  return content.replace(ANY_BLOCK_PATTERN, '')
}

export function renderTriggerBlock(b: Bundle, mapRelative: string): string {
  return [
    startMarker(b.id),
    `## Skill group: ${b.name}`,
    `**Trigger:** ${b.trigger.trim()}`,
    `**On match only:** read \`${mapRelative}\` and select one skill from it. Do not load these skills otherwise.`,
    endMarker(b.id),
  ].join('\n')
}

// Description priority: per-bundle override → source frontmatter description.
// No body-excerpt fallback — validation requires the user to supply one when
// the source has nothing, so reaching here without text is a real bug.
function describeRow(row: ResolvedSkillRow): string {
  const override = row.entry.description?.trim()
  if (override) return override
  return row.skill.description?.trim() ?? ''
}

export function renderMapFile(b: Bundle, rows: ResolvedSkillRow[]): string {
  const lines: string[] = [
    `# Skill map: ${b.name}`,
    '',
    'Consult this file only when the trigger condition in the parent MD has matched. Select one skill below and invoke it.',
    '',
    `**Trigger recap:** ${b.trigger.trim()}`,
    '',
    '---',
    '',
  ]
  if (rows.length === 0) {
    lines.push('_No skills currently associated with this bundle._')
  }
  for (const row of rows) {
    const s = row.skill
    const heading = s.type === 'command' ? `${s.name}  (\`/${s.name}\`)` : s.name
    lines.push(`## ${heading}`)
    const summary = describeRow(row)
    if (summary) lines.push(summary)
    lines.push('')
    lines.push(`- Type: \`${s.type}\``)
    lines.push(`- Scope: \`${s.scope}\``)
    lines.push(`- Path: \`${s.path}\``)
    lines.push('')
  }
  return lines.join('\n') + '\n'
}

function readIfExists(p: string): string {
  try {
    return fs.readFileSync(p, 'utf-8')
  } catch {
    return ''
  }
}

function writeAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, filePath)
}

function stripBlock(existing: string, id: string): string {
  return existing.replace(blockRegex(id), '\n').replace(/\n{3,}/g, '\n\n')
}

// Apply (enable) a bundle: inject/replace the marker block in the top file
// and write the map file.
export function applyBundle(b: Bundle, rows: ResolvedSkillRow[]): { topFile: string; mapFile: string } {
  const paths = resolveBundlePaths(b)
  const trigger = renderTriggerBlock(b, paths.mapRelative)

  const existing = readIfExists(paths.topFile)
  const stripped = stripBlock(existing, b.id)
  const trimmed = stripped.replace(/\s+$/, '')
  const next = trimmed.length === 0
    ? `${trigger}\n`
    : `${trimmed}\n\n${trigger}\n`

  writeAtomic(paths.topFile, next)
  writeAtomic(paths.mapFile, renderMapFile(b, rows))

  return { topFile: paths.topFile, mapFile: paths.mapFile }
}

// Remove a bundle's footprint: strip the marker block, delete the map file.
// Leaves the top file in place even if the block was its only content.
export function removeBundle(b: Bundle): { topFile: string; mapFile: string } {
  const paths = resolveBundlePaths(b)

  const existing = readIfExists(paths.topFile)
  if (existing.length > 0) {
    const stripped = stripBlock(existing, b.id).replace(/\s+$/, '')
    if (stripped.length === 0 && existing.trim().startsWith(startMarker(b.id))) {
      // Top file only ever held our block — remove it entirely.
      try { fs.unlinkSync(paths.topFile) } catch { /* already gone */ }
    } else {
      writeAtomic(paths.topFile, stripped + (stripped.endsWith('\n') ? '' : '\n'))
    }
  }

  try { fs.unlinkSync(paths.mapFile) } catch { /* already gone */ }
  // Clean up empty super-router/ dir for tidiness, ignore failures.
  try { fs.rmdirSync(path.dirname(paths.mapFile)) } catch { /* not empty or missing */ }

  return { topFile: paths.topFile, mapFile: paths.mapFile }
}

export const __test = { renderTriggerBlock, renderMapFile, stripBlock, startMarker, endMarker, describeRow }

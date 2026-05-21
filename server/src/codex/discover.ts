// Codex CLI inventory discovery.
//
// Codex's file model differs from Claude Code's:
//   - No `skills/<name>/SKILL.md` registry, no slash-commands dir, no agents/.
//   - The only documented per-context instruction file is `AGENTS.md`.
//   - One AGENTS.md at the root of `~/.codex/` is treated as a global skill;
//     each project's `<cwd>/AGENTS.md` is a project-scoped skill.
//   - Project paths are mined from Codex session JSONLs (each session
//     records its working directory).
//
// All discovered files are returned as the same `Skill` shape used by Claude
// and Cursor — that keeps the inventory table and health system uniform.
// See planning_notes/CODEX.md for the underlying decisions.

import fs from 'fs'
import path from 'path'
import { buildSkill } from '../scanner/discover'
import type { Skill } from '../scanner/types'

// Read the first few lines of a JSONL file looking for a top-level `cwd`
// field. Codex session schemas vary across versions — some put a meta line
// first with cwd/model/started_at, some embed it inside a `meta` object.
// We bound the scan so a giant session file doesn't dominate inventory load.
const META_SCAN_LINES = 10

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function readCwdFromSession(file: string): string | null {
  let raw: string
  try { raw = fs.readFileSync(file, 'utf-8') } catch { return null }
  const lines = raw.split('\n', META_SCAN_LINES + 1)
  for (const line of lines.slice(0, META_SCAN_LINES)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>
      // Top-level cwd.
      if (typeof obj['cwd'] === 'string') return obj['cwd']
      // Nested meta.cwd.
      const meta = obj['meta']
      if (meta && typeof meta === 'object' && typeof (meta as Record<string, unknown>)['cwd'] === 'string') {
        return (meta as Record<string, unknown>)['cwd'] as string
      }
    } catch {
      // Non-JSON line — keep scanning. Codex sometimes emits a banner line.
    }
  }
  return null
}

// Returns deduplicated cwd paths mined from every JSONL in `~/.codex/sessions/`.
// Skips files that don't expose a cwd — those just don't contribute to the
// project list, no error surfaced.
export function findCodexProjectCwds(accountDir: string): string[] {
  const sessionsDir = path.join(accountDir, 'sessions')
  if (!isDir(sessionsDir)) return []
  let entries: string[]
  try {
    entries = fs.readdirSync(sessionsDir)
  } catch {
    return []
  }
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue
    const cwd = readCwdFromSession(path.join(sessionsDir, entry))
    if (cwd) seen.add(cwd)
  }
  return [...seen]
}

const CODEX_ACCOUNT = 'codex'

export function discoverCodexSkills(accountDir: string): Skill[] {
  const skills: Skill[] = []

  // Global scope: ~/.codex/AGENTS.md.
  const globalAgents = path.join(accountDir, 'AGENTS.md')
  if (fs.existsSync(globalAgents)) {
    const skill = buildSkill(
      globalAgents,
      'skill',
      'global',
      CODEX_ACCOUNT,
      'AGENTS', // override: dirname is `.codex`, which makes a bad name
    )
    if (skill) skills.push(skill)
  }

  // Project scope: <cwd>/AGENTS.md for every distinct cwd in the session log.
  for (const cwd of findCodexProjectCwds(accountDir)) {
    const projectAgents = path.join(cwd, 'AGENTS.md')
    if (!fs.existsSync(projectAgents)) continue
    const skill = buildSkill(
      projectAgents,
      'skill',
      'project',
      CODEX_ACCOUNT,
      path.basename(cwd) || 'AGENTS', // name reflects the project dir, not "AGENTS"
      cwd, // projectId
    )
    if (skill) skills.push(skill)
  }

  return skills
}

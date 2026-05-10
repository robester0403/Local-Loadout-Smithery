#!/usr/bin/env tsx
// Cursor per-skill activation report. Reads the user's Cursor globalStorage
// SQLite, finds every assistant turn that loaded a skill (via the
// read_file_v2 / read_file / Read tool reading a SKILL.md inside a recognized
// loadout dir), and reports per-skill activation counts, last-invoked dates,
// and composer reach.
//
//   tsx server/scripts/cursor-skill-cost.ts
//
// Why no dollar cost column:
//   We investigated three potential cost sources in Cursor's local SQLite:
//     1. bubble.tokenCount.{input,output}Tokens — populated only on the head
//        assistant bubble per request (~1,771 of ~40k bubbles), and never on
//        tool-call bubbles. In observed data, the composers that contain
//        skill activations have token counts of zero on every bubble.
//     2. composerData.usageData — { [model]: { costInCents, amount } }.
//        Cursor's billing rollup. Populated for 174/370 composers, but ALL
//        cost-bearing composers in the test data are from before
//        2026-02-24. Cursor stopped writing this field in newer sessions —
//        billing now lives server-side, inaccessible without an API.
//     3. ItemTable rolling lists (cursor.skills.recentlyUsed etc.) — no
//        timestamps, no per-session attribution, no cost.
//   Conclusion: per-skill dollar cost is not extractable from current
//   Cursor local data. Activation volume is.

import { execFileSync } from 'child_process'
import os from 'os'
import path from 'path'

const DB = path.join(
  os.homedir(),
  'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb',
)

const SKILL_TOOL_NAMES = new Set(['read_file', 'read_file_v2', 'Read'])
// Filter false positives: only count SKILL.md reads inside a recognized
// loadout directory (avoids picking up sample files in cloned repos, files
// in ~/Downloads, etc.).
const LOADOUT_DIR_RE = /\/(?:skills|skills-cursor|agents|commands)\//

interface ToolCall { name?: string; params?: unknown; rawArgs?: unknown }
interface BubbleRow {
  composerId: string
  type: number
  createdAt: number   // ms epoch, 0 if unparseable
  toolFormerData: ToolCall | null
}

// Pre-filter at the SQL layer to bubbles mentioning SKILL.md — only ~hundreds
// of those vs ~40k assistant bubbles total, so streaming everything would be
// wasteful.
function readSkillReadingBubbles(): BubbleRow[] {
  const out = execFileSync(
    'sqlite3',
    [
      '-json',
      DB,
      `SELECT key,
              json_extract(value, '$.type') AS type,
              json_extract(value, '$.createdAt') AS createdAt,
              json_extract(value, '$.toolFormerData.name') AS toolName,
              json_extract(value, '$.toolFormerData.params') AS toolParams,
              json_extract(value, '$.toolFormerData.rawArgs') AS toolRawArgs
         FROM cursorDiskKV
        WHERE key LIKE 'bubbleId:%' AND value LIKE '%SKILL.md%';`,
    ],
    { maxBuffer: 1024 * 1024 * 256, encoding: 'utf-8' },
  )
  if (!out.trim()) return []

  const rows = JSON.parse(out) as Array<Record<string, unknown>>
  const bubbles: BubbleRow[] = []
  for (const row of rows) {
    const key = row['key'] as string
    const parts = key.split(':')
    if (parts.length < 3) continue
    // createdAt is stored as an ISO string in modern Cursor data; very old
    // sessions sometimes used a numeric epoch. Handle both.
    const ca = row['createdAt']
    let createdAt = 0
    if (typeof ca === 'number') createdAt = ca
    else if (typeof ca === 'string') {
      const t = Date.parse(ca)
      if (Number.isFinite(t)) createdAt = t
    }
    bubbles.push({
      composerId: parts[1],
      type: (row['type'] as number | null) ?? 0,
      createdAt,
      toolFormerData: {
        name: row['toolName'] as string | undefined,
        params: row['toolParams'] as unknown,
        rawArgs: row['toolRawArgs'] as unknown,
      },
    })
  }
  return bubbles
}

// ─── Attribution ────────────────────────────────────────────────────────────

// Walk a value tree looking for a string ending in '/SKILL.md'. Leaf check is
// `endsWith` not `includes` — a JSON-encoded envelope like
// `{"targetFile":"…/SKILL.md","limit":30}` contains the substring but isn't
// itself a path; without the strict suffix check we'd return the envelope.
function pickPathLike(v: unknown): string | null {
  if (typeof v === 'string') {
    if (v.endsWith('/SKILL.md')) return v
    try {
      const inner = JSON.parse(v) as unknown
      if (typeof inner === 'string' && inner === v) return null
      return pickPathLike(inner)
    } catch {
      return null
    }
  }
  if (v && typeof v === 'object') {
    for (const value of Object.values(v as Record<string, unknown>)) {
      const r = pickPathLike(value)
      if (r) return r
    }
  }
  return null
}

function extractSkillName(tool: ToolCall): string | null {
  if (!tool.name || !SKILL_TOOL_NAMES.has(tool.name)) return null
  const candidate = pickPathLike(tool.params) ?? pickPathLike(tool.rawArgs)
  if (!candidate) return null
  if (!LOADOUT_DIR_RE.test(candidate)) return null
  // .../skills-cursor/foo/SKILL.md  →  foo
  const segments = candidate.split('/')
  if (segments.length < 2) return null
  return segments[segments.length - 2]
}

interface SkillRollup {
  skill: string
  activations: number
  composers: Set<string>
  lastInvoked: number   // ms epoch, 0 if unknown
}

function rollup(bubbles: BubbleRow[]): SkillRollup[] {
  const tally = new Map<string, SkillRollup>()
  for (const b of bubbles) {
    if (b.type !== 2 || !b.toolFormerData) continue
    const skill = extractSkillName(b.toolFormerData)
    if (!skill) continue

    const entry = tally.get(skill) ?? {
      skill, activations: 0, composers: new Set<string>(), lastInvoked: 0,
    }
    entry.activations += 1
    entry.composers.add(b.composerId)
    if (b.createdAt > entry.lastInvoked) entry.lastInvoked = b.createdAt
    tally.set(skill, entry)
  }
  return Array.from(tally.values())
}

// ─── Output ─────────────────────────────────────────────────────────────────

function fmtRelativeDate(ms: number): string {
  if (!ms) return '—'
  const days = Math.floor((Date.now() - ms) / 86_400_000)
  if (days < 0) return 'future'
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

function main(): void {
  console.log(`Reading ${DB}…`)
  const bubbles = readSkillReadingBubbles()
  console.log(`Skill-mentioning bubbles: ${bubbles.length}`)

  const rolled = rollup(bubbles).sort(
    (a, b) => b.activations - a.activations || b.lastInvoked - a.lastInvoked,
  )
  const totalActivations = rolled.reduce((sum, r) => sum + r.activations, 0)
  const distinctComposers = new Set<string>()
  for (const r of rolled) for (const c of r.composers) distinctComposers.add(c)

  console.log('')
  console.log(`Total activations:        ${totalActivations}`)
  console.log(`Distinct skills:          ${rolled.length}`)
  console.log(`Distinct composers:       ${distinctComposers.size}`)
  console.log('')

  if (rolled.length === 0) {
    console.log('No skill activations found.')
    return
  }

  const w = (s: string, n: number) => s.padEnd(n)
  console.log(
    w('SKILL', 38) +
    w('ACTIVATIONS', 14) +
    w('SESSIONS', 12) +
    'LAST INVOKED',
  )
  console.log('─'.repeat(82))
  for (const r of rolled) {
    console.log(
      w(r.skill, 38) +
      w(String(r.activations), 14) +
      w(String(r.composers.size), 12) +
      fmtRelativeDate(r.lastInvoked),
    )
  }
}

main()

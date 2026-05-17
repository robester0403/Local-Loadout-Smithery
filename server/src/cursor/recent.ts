// Live Cursor activity tracking via the recently-used lists in Cursor's
// globalStorage SQLite (ItemTable rows: cursor.skills.recentlyUsed,
// cursor.commands.recentlyUsed, cursor.subagents.recentlyUsed,
// cursor.recentlyUsed.globalOrder).
//
// Why this layer exists: bubble-level activation data stopped being
// persisted post Cursor 2.0, so the historical /api/cursor/usage rollup
// can't tell us what's been used recently. The recently-used lists ARE
// still being written, so we snapshot them, diff between observations,
// and append activation events to our own append-only log. The result is
// a usage history we own, accumulating from the moment polling started.
//
// Caveats baked into the design:
//   - The list is recency-ordered, not timestamped. We record observation
//     time, not Cursor's actual invocation time (delta of seconds).
//   - A skill that's already at position 0 and gets re-invoked produces
//     no list change → we miss the re-activation. Acceptable; the
//     aggregate count still reflects which skills are favourites.
//   - We can't determine the list's true cap from one host. Assume there's
//     no relevant cap unless we observe overflow in practice.

import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { CURSOR_DB_PATH, isCursorDatabaseAvailable } from './db'

export type CursorArtifactKind = 'skill' | 'command' | 'subagent'

export interface CursorRecentSnapshot {
  /** ms epoch when this snapshot was taken. */
  observedAt: number
  /** Identifiers in recency order, position 0 = most recent. */
  skills: string[]
  commands: string[]
  subagents: string[]
}

export interface CursorActivationEvent {
  /** Normalised name (matches scanner output, e.g. 'morning-plan'). */
  name: string
  kind: CursorArtifactKind
  observedAt: number
}

/** ~/.local-loadout-smithery/cursor-activity.jsonl */
export const ACTIVITY_LOG_PATH = path.join(
  os.homedir(),
  '.local-loadout-smithery',
  'cursor-activity.jsonl',
)

// ─── Snapshot read ──────────────────────────────────────────────────────────

/**
 * Read all three recently-used lists in one sqlite3 invocation. Returns an
 * empty snapshot (with a current observedAt) when Cursor isn't installed
 * or the lists don't exist yet — caller treats empty as a no-op diff.
 */
export function readRecentSnapshot(dbPath: string = CURSOR_DB_PATH): CursorRecentSnapshot {
  const observedAt = Date.now()
  if (!isCursorDatabaseAvailable(dbPath)) {
    return { observedAt, skills: [], commands: [], subagents: [] }
  }

  const out = execFileSync(
    'sqlite3',
    [
      '-json',
      dbPath,
      `SELECT key, value FROM ItemTable
        WHERE key IN (
          'cursor.skills.recentlyUsed',
          'cursor.commands.recentlyUsed',
          'cursor.subagents.recentlyUsed'
        );`,
    ],
    { maxBuffer: 1024 * 1024, encoding: 'utf-8' },
  )
  const snap: CursorRecentSnapshot = { observedAt, skills: [], commands: [], subagents: [] }
  if (!out.trim()) return snap

  const rows = JSON.parse(out) as Array<{ key: string; value: string }>
  for (const row of rows) {
    let parsed: unknown
    try { parsed = JSON.parse(row.value) } catch { continue }
    if (!Array.isArray(parsed)) continue
    const list = parsed.filter((x): x is string => typeof x === 'string')
    if (row.key === 'cursor.skills.recentlyUsed') snap.skills = list
    else if (row.key === 'cursor.commands.recentlyUsed') snap.commands = list
    else if (row.key === 'cursor.subagents.recentlyUsed') snap.subagents = list
  }
  return snap
}

// ─── Identifier → name normalisation ────────────────────────────────────────

/**
 * Cursor stores identifiers in shape-varying forms:
 *   - skills:    'foo/SKILL.md'         → 'foo'
 *   - commands:  'kibana/document.md'   → 'document'  (basename, no extension)
 *   - subagents: 'kb-evaluator'         → 'kb-evaluator'
 *
 * We normalise to the bare name so the rollup can join against scanner output.
 */
export function identifierToName(id: string, kind: CursorArtifactKind): string {
  if (kind === 'skill') {
    if (id.endsWith('/SKILL.md')) return id.slice(0, -'/SKILL.md'.length).split('/').pop() ?? id
    return id
  }
  if (kind === 'command') {
    const base = id.split('/').pop() ?? id
    return base.endsWith('.md') ? base.slice(0, -3) : base
  }
  // subagent: identifier IS the name
  return id
}

// ─── Diff: previous snapshot → activation events ────────────────────────────

/**
 * An activation is detected when an identifier's position in the list has
 * decreased (moved closer to the top), or when it's appearing for the
 * first time.
 *
 * Edge case: a skill already at position 0 that gets re-invoked produces
 * no list change. We can't detect that case at all; documented in the
 * module header.
 */
export function diffSnapshots(
  prev: CursorRecentSnapshot | null,
  next: CursorRecentSnapshot,
): CursorActivationEvent[] {
  const events: CursorActivationEvent[] = []
  const compare = (
    prevList: string[] | undefined,
    nextList: string[],
    kind: CursorArtifactKind,
  ): void => {
    const prevPos = new Map<string, number>()
    if (prevList) prevList.forEach((id, i) => prevPos.set(id, i))
    nextList.forEach((id, nextIdx) => {
      const prevIdx = prevPos.get(id)
      // New entry, OR moved up the list (lower index = more recent).
      if (prevIdx === undefined || nextIdx < prevIdx) {
        events.push({
          name: identifierToName(id, kind),
          kind,
          observedAt: next.observedAt,
        })
      }
    })
  }
  compare(prev?.skills, next.skills, 'skill')
  compare(prev?.commands, next.commands, 'command')
  compare(prev?.subagents, next.subagents, 'subagent')
  return events
}

// ─── Append-only JSONL log ──────────────────────────────────────────────────

function ensureLogDir(): void {
  const dir = path.dirname(ACTIVITY_LOG_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

export function appendEvents(events: CursorActivationEvent[]): void {
  if (events.length === 0) return
  ensureLogDir()
  const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n'
  fs.appendFileSync(ACTIVITY_LOG_PATH, lines, 'utf-8')
}

export function readEvents(): CursorActivationEvent[] {
  if (!fs.existsSync(ACTIVITY_LOG_PATH)) return []
  const raw = fs.readFileSync(ACTIVITY_LOG_PATH, 'utf-8')
  const events: CursorActivationEvent[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line) as CursorActivationEvent
      if (ev && typeof ev.name === 'string' && typeof ev.observedAt === 'number') {
        events.push(ev)
      }
    } catch {
      // Skip corrupted lines — don't fail the whole read.
    }
  }
  return events
}

// ─── Rollup ─────────────────────────────────────────────────────────────────

export interface CursorRecentSkillUsage {
  name: string
  kind: CursorArtifactKind
  /** How many activations recorded since polling began. */
  count: number
  /** ms epoch of first observed activation. */
  firstSeen: number
  /** ms epoch of most recent activation. */
  lastSeen: number
}

export interface CursorRecentUsageReport {
  /** True when the polling log exists and has at least one event. */
  hasData: boolean
  /** ms epoch of earliest event in log; 0 if empty. */
  trackingSince: number
  /** Per-name rollup, sorted by count desc, lastSeen desc. */
  items: CursorRecentSkillUsage[]
  /** Total event count across all items. */
  totalEvents: number
}

export function rollupEvents(events: CursorActivationEvent[]): CursorRecentUsageReport {
  if (events.length === 0) {
    return { hasData: false, trackingSince: 0, items: [], totalEvents: 0 }
  }
  const byKey = new Map<string, CursorRecentSkillUsage>()
  let earliest = Number.POSITIVE_INFINITY
  for (const e of events) {
    if (e.observedAt < earliest) earliest = e.observedAt
    const key = `${e.kind}:${e.name}`
    const existing = byKey.get(key)
    if (existing) {
      existing.count++
      if (e.observedAt > existing.lastSeen) existing.lastSeen = e.observedAt
      if (e.observedAt < existing.firstSeen) existing.firstSeen = e.observedAt
    } else {
      byKey.set(key, {
        name: e.name,
        kind: e.kind,
        count: 1,
        firstSeen: e.observedAt,
        lastSeen: e.observedAt,
      })
    }
  }
  const items = [...byKey.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    return b.lastSeen - a.lastSeen
  })
  return {
    hasData: true,
    trackingSince: Number.isFinite(earliest) ? earliest : 0,
    items,
    totalEvents: events.length,
  }
}

export function computeCursorRecentUsage(): CursorRecentUsageReport {
  return rollupEvents(readEvents())
}

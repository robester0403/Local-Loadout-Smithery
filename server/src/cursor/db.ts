// Read-only access to Cursor's globalStorage SQLite. We shell to the system
// `sqlite3` CLI rather than pulling in a native dependency — keeps the
// install footprint tiny and matches how the rest of the project uses
// already-available system tools.

import { execFileSync } from 'child_process'
import os from 'os'
import path from 'path'

export const CURSOR_DB_PATH = path.join(
  os.homedir(),
  'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb',
)

/** Tool-call payload as it appears on a single bubble. */
export interface CursorToolCall {
  name?: string
  params?: unknown
  rawArgs?: unknown
}

/** Subset of bubble fields we read for activation detection. */
export interface CursorBubble {
  composerId: string
  /** 1 = user, 2 = assistant. */
  type: number
  /** ms epoch parsed from createdAt; 0 if missing/unparseable. */
  createdAt: number
  toolFormerData: CursorToolCall | null
}

/**
 * Pre-filter at the SQL layer to bubbles whose value mentions 'SKILL.md'.
 * In observed data ~622 of 43k bubbles match — we don't want to stream the
 * other 42k+ for nothing.
 */
export function readSkillReadingBubbles(dbPath: string = CURSOR_DB_PATH): CursorBubble[] {
  const out = execFileSync(
    'sqlite3',
    [
      '-json',
      dbPath,
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
  const bubbles: CursorBubble[] = []
  for (const row of rows) {
    const key = row['key'] as string
    // key format: bubbleId:<composerId>:<bubbleId>
    const parts = key.split(':')
    if (parts.length < 3) continue

    bubbles.push({
      composerId: parts[1],
      type: (row['type'] as number | null) ?? 0,
      createdAt: parseTimestamp(row['createdAt']),
      toolFormerData: {
        name: row['toolName'] as string | undefined,
        params: row['toolParams'] as unknown,
        rawArgs: row['toolRawArgs'] as unknown,
      },
    })
  }
  return bubbles
}

/**
 * Cursor stores `createdAt` as an ISO 8601 string in modern sessions and
 * (rarely) as a numeric epoch in older ones. Accept either; default to 0
 * if neither parses.
 */
function parseTimestamp(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    if (Number.isFinite(t)) return t
  }
  return 0
}

/** Returns false when the Cursor SQLite isn't accessible (Cursor not
 *  installed, sandboxed env, etc.). Cheap fs check; doesn't open the DB. */
export function isCursorDatabaseAvailable(dbPath: string = CURSOR_DB_PATH): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs')
    return fs.existsSync(dbPath)
  } catch {
    return false
  }
}

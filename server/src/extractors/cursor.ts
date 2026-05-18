import { execFileSync } from 'child_process'
import { CURSOR_DB_PATH, isCursorDatabaseAvailable } from '../cursor/db'
import type { ConversationMessage, ConversationRecord } from './types'

// Cursor stores chat in a kv table: cursorDiskKV, keyed `bubbleId:<composerId>:<bubbleId>`.
// Each row's value is a JSON blob with `$.type` (1=user, 2=assistant), `$.text`,
// `$.createdAt` (ISO string), and lots of metadata we don't care about. We
// shell to sqlite3 -json and rebuild conversations by composerId.

interface CursorRow {
  key: string
  type: number | null
  text: string | null
  createdAt: string | null
}

function querySqlite(sinceMs: number): CursorRow[] {
  // Pull every bubble that has non-null text and (when known) a createdAt
  // newer than `sinceMs`. Cursor's createdAt is ISO 8601 in modern sessions,
  // so we filter in JS to avoid SQL date-string comparisons on a column we
  // don't fully control.
  const out = execFileSync(
    'sqlite3',
    [
      '-json',
      CURSOR_DB_PATH,
      `SELECT key,
              json_extract(value, '$.type') AS type,
              json_extract(value, '$.text') AS text,
              json_extract(value, '$.createdAt') AS createdAt
         FROM cursorDiskKV
        WHERE key LIKE 'bubbleId:%'
          AND json_extract(value, '$.text') IS NOT NULL
          AND length(json_extract(value, '$.text')) > 0;`,
    ],
    { maxBuffer: 1024 * 1024 * 256, encoding: 'utf-8' },
  )
  if (!out.trim()) return []
  const rows = JSON.parse(out) as Array<Record<string, unknown>>
  const filtered: CursorRow[] = []
  for (const r of rows) {
    const createdAt = typeof r['createdAt'] === 'string' ? r['createdAt'] as string : null
    if (sinceMs > 0 && createdAt) {
      const t = Date.parse(createdAt)
      if (Number.isFinite(t) && t < sinceMs) continue
    }
    filtered.push({
      key: r['key'] as string,
      type: (r['type'] as number | null) ?? null,
      text: (r['text'] as string | null) ?? null,
      createdAt,
    })
  }
  return filtered
}

export function extractCursorConversations(since: number): {
  records: ConversationRecord[]
  warnings: string[]
  newHighWaterMark: number
} {
  const warnings: string[] = []
  if (!isCursorDatabaseAvailable()) {
    warnings.push('Cursor database not found — skipping.')
    return { records: [], warnings, newHighWaterMark: since }
  }

  let rows: CursorRow[]
  try {
    rows = querySqlite(since)
  } catch (e) {
    warnings.push(`Cursor SQLite query failed: ${(e as Error).message}`)
    return { records: [], warnings, newHighWaterMark: since }
  }

  interface Bubble {
    bubbleId: string
    composerId: string
    role: 'user' | 'assistant'
    content: string
    timestamp: string
    ts: number
  }

  const byComposer = new Map<string, Bubble[]>()
  let max = since

  for (const r of rows) {
    // key shape: bubbleId:<composerId>:<bubbleId>
    const parts = r.key.split(':')
    if (parts.length < 3) continue
    const composerId = parts[1]
    const bubbleId = parts.slice(2).join(':')
    if (r.type !== 1 && r.type !== 2) continue
    if (!r.text) continue
    const role: 'user' | 'assistant' = r.type === 1 ? 'user' : 'assistant'
    const timestamp = r.createdAt ?? ''
    const ts = timestamp ? Date.parse(timestamp) : 0
    if (ts > max) max = ts

    const bub: Bubble = { bubbleId, composerId, role, content: r.text, timestamp, ts }
    const arr = byComposer.get(composerId) ?? []
    arr.push(bub)
    byComposer.set(composerId, arr)
  }

  const records: ConversationRecord[] = []
  for (const [composerId, bubbles] of byComposer.entries()) {
    bubbles.sort((a, b) => a.ts - b.ts)
    const messages: ConversationMessage[] = bubbles.map(b => ({
      id: b.bubbleId,
      role: b.role,
      content: b.content,
      timestamp: b.timestamp,
    }))
    records.push({
      id: `cursor:${composerId}`,
      source: 'cursor',
      sessionId: composerId,
      // Cursor's bubble JSON doesn't carry a workspace path in a stable
      // field for our query. Cross-referencing with cursorProjects is
      // possible later — for now leave blank.
      projectPath: '',
      startedAt: bubbles[0]?.timestamp ?? '',
      endedAt: bubbles[bubbles.length - 1]?.timestamp ?? '',
      messages,
    })
  }

  return { records, warnings, newHighWaterMark: max }
}

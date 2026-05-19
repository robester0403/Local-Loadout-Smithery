import fs from 'fs'
import { findSessionFiles } from '../usage/parser'
import type { ConversationMessage, ConversationRecord } from './types'

// Each Claude Code session JSONL holds a series of turns. The shape we care
// about: { type: 'user' | 'assistant', message: { role, content }, sessionId,
// cwd, timestamp, uuid }. Tool-use blocks inside an assistant message get
// summarized to keep the message text useful for digestion without dumping
// raw tool args (which are often huge).

interface ClaudeContentBlock {
  type?: string
  text?: string
  name?: string
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as ClaudeContentBlock
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text)
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      parts.push(`[tool: ${b.name}]`)
    } else if (b.type === 'tool_result' && typeof b.text === 'string') {
      // Truncate tool results — they can be massive (file dumps, lint output).
      parts.push(`[tool_result: ${b.text.slice(0, 200)}${b.text.length > 200 ? '…' : ''}]`)
    }
  }
  return parts.join('\n')
}

interface Turn {
  uuid: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  sessionId: string
  cwd: string
  ts: number
}

function parseSessionTurns(filePath: string, sinceMs: number, warnings: string[]): Turn[] {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    warnings.push(`Could not read ${filePath}`)
    return []
  }
  const turns: Turn[] = []
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    let obj: Record<string, unknown>
    try { obj = JSON.parse(line) as Record<string, unknown> } catch { continue }

    const type = obj['type']
    if (type !== 'user' && type !== 'assistant') continue

    const msg = obj['message']
    if (msg == null || typeof msg !== 'object') continue
    const message = msg as Record<string, unknown>

    const role = message['role']
    if (role !== 'user' && role !== 'assistant') continue

    const content = flattenContent(message['content'])
    if (!content.trim()) continue

    const timestamp = typeof obj['timestamp'] === 'string' ? (obj['timestamp'] as string) : ''
    const ts = timestamp ? Date.parse(timestamp) : 0
    if (sinceMs > 0 && ts > 0 && ts < sinceMs) continue

    const uuid = typeof obj['uuid'] === 'string' ? obj['uuid'] as string : `${filePath}:${i}`
    const sessionId = typeof obj['sessionId'] === 'string' ? obj['sessionId'] as string : ''
    const cwd = typeof obj['cwd'] === 'string' ? obj['cwd'] as string : ''

    turns.push({ uuid, role: role as 'user' | 'assistant', content, timestamp, sessionId, cwd, ts })
  }
  return turns
}

// Re-load a single conversation by sessionId from the original Claude
// session JSONL. Used by the synth-body path so the bigger model has the
// actual conversation text to work from rather than the ~120 char excerpt
// kept on the candidate. The source files are owned by Claude Code and
// always exist regardless of our extract/purge cycle.
//
// Claude names each session file <sessionId>.jsonl under .../projects/
// /<projectHash>/, so we can find the right file by name without a full
// scan once we know the id.
export function extractClaudeConversationById(sessionId: string): ConversationRecord | null {
  const warnings: string[] = []
  for (const file of findSessionFiles()) {
    if (!file.endsWith(`/${sessionId}.jsonl`)) continue
    const turns = parseSessionTurns(file, 0, warnings).filter(t => t.sessionId === sessionId)
    if (turns.length === 0) continue
    turns.sort((a, b) => a.ts - b.ts)
    const messages: ConversationMessage[] = turns.map(t => ({
      id: t.uuid,
      role: t.role,
      content: t.content,
      timestamp: t.timestamp,
    }))
    return {
      id: `claude:${sessionId}`,
      source: 'claude',
      sessionId,
      projectPath: turns[0]?.cwd ?? '',
      startedAt: turns[0]?.timestamp ?? '',
      endedAt: turns[turns.length - 1]?.timestamp ?? '',
      messages,
    }
  }
  return null
}

// Group turns by sessionId into ConversationRecord. A session = one conversation.
// `since` is a ms epoch; only turns at-or-after that time are included. Sessions
// whose newest turn ends before `since` are dropped entirely.
export function extractClaudeConversations(since: number): {
  records: ConversationRecord[]
  warnings: string[]
  newHighWaterMark: number
} {
  const warnings: string[] = []
  const bySession = new Map<string, Turn[]>()
  let max = since

  for (const file of findSessionFiles()) {
    const turns = parseSessionTurns(file, since, warnings)
    for (const t of turns) {
      if (!t.sessionId) continue
      const arr = bySession.get(t.sessionId) ?? []
      arr.push(t)
      bySession.set(t.sessionId, arr)
      if (t.ts > max) max = t.ts
    }
  }

  const records: ConversationRecord[] = []
  for (const [sessionId, turns] of bySession.entries()) {
    turns.sort((a, b) => a.ts - b.ts)
    const messages: ConversationMessage[] = turns.map(t => ({
      id: t.uuid,
      role: t.role,
      content: t.content,
      timestamp: t.timestamp,
    }))
    records.push({
      id: `claude:${sessionId}`,
      source: 'claude',
      sessionId,
      projectPath: turns[0]?.cwd ?? '',
      startedAt: turns[0]?.timestamp ?? '',
      endedAt: turns[turns.length - 1]?.timestamp ?? '',
      messages,
    })
  }

  return { records, warnings, newHighWaterMark: max }
}

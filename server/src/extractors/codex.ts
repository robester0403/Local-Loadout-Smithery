import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ConversationMessage, ConversationRecord } from './types'

// Codex CLI's on-disk history location varies between versions; known
// candidates are listed here and we use the first that exists. Format is
// expected to be JSONL with one message per line, fields { id, role, content,
// timestamp, sessionId }, but we tolerate variants.
const CANDIDATE_DIRS = [
  path.join(os.homedir(), '.codex', 'sessions'),
  path.join(os.homedir(), '.config', 'codex', 'sessions'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Codex', 'sessions'),
]

function findHistoryDir(): string | null {
  for (const dir of CANDIDATE_DIRS) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir
    } catch { /* keep looking */ }
  }
  return null
}

interface CodexLine {
  id?: string
  role?: string
  content?: unknown
  text?: string
  timestamp?: string
  created_at?: string
  sessionId?: string
  session_id?: string
}

function flatten(content: unknown, text: unknown): string {
  if (typeof text === 'string' && text.trim()) return text
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(b => {
        if (typeof b === 'string') return b
        if (b && typeof b === 'object' && typeof (b as { text?: string }).text === 'string') {
          return (b as { text: string }).text
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

// Re-load a single Codex session by id. Codex commonly names each session
// file after its session id, so we try that filename first; fall back to a
// full scan looking for a matching session inside any file.
export function extractCodexConversationById(sessionId: string): ConversationRecord | null {
  const dir = findHistoryDir()
  if (!dir) return null

  function parseFile(file: string): ConversationRecord | null {
    let raw: string
    try { raw = fs.readFileSync(file, 'utf-8') } catch { return null }
    const fileSession = path.basename(file).replace(/\.jsonl$/, '')
    interface Msg { id: string; role: 'user' | 'assistant'; content: string; timestamp: string; ts: number }
    const msgs: Msg[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let obj: CodexLine
      try { obj = JSON.parse(trimmed) as CodexLine } catch { continue }
      const role = obj.role
      if (role !== 'user' && role !== 'assistant') continue
      const candidateSession = obj.sessionId ?? obj.session_id ?? fileSession
      if (candidateSession !== sessionId) continue
      const content = flatten(obj.content, obj.text)
      if (!content.trim()) continue
      const timestamp = obj.timestamp ?? obj.created_at ?? ''
      const ts = timestamp ? Date.parse(timestamp) : 0
      const id = obj.id ?? `${sessionId}:${msgs.length}`
      msgs.push({ id, role, content, timestamp, ts })
    }
    if (msgs.length === 0) return null
    msgs.sort((a, b) => a.ts - b.ts)
    return {
      id: `codex:${sessionId}`,
      source: 'codex',
      sessionId,
      projectPath: '',
      startedAt: msgs[0].timestamp,
      endedAt: msgs[msgs.length - 1].timestamp,
      messages: msgs.map(m => ({ id: m.id, role: m.role, content: m.content, timestamp: m.timestamp })),
    }
  }

  // Try the conventional file-named-after-session first.
  const direct = path.join(dir, `${sessionId}.jsonl`)
  if (fs.existsSync(direct)) {
    const r = parseFile(direct)
    if (r) return r
  }
  // Fallback scan: rare paths where the file name diverges from the session id.
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const r = parseFile(path.join(dir, f))
      if (r) return r
    }
  } catch { /* dir gone */ }
  return null
}

export function extractCodexConversations(since: number): {
  records: ConversationRecord[]
  warnings: string[]
  newHighWaterMark: number
} {
  const warnings: string[] = []
  const dir = findHistoryDir()
  if (!dir) {
    warnings.push('Codex history directory not found in known locations — skipping.')
    return { records: [], warnings, newHighWaterMark: since }
  }

  interface Msg {
    id: string
    role: 'user' | 'assistant'
    content: string
    timestamp: string
    ts: number
    sessionId: string
  }

  const bySession = new Map<string, Msg[]>()
  let max = since

  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f))
  } catch (e) {
    warnings.push(`Could not list ${dir}: ${(e as Error).message}`)
    return { records: [], warnings, newHighWaterMark: since }
  }

  for (const file of files) {
    let raw: string
    try { raw = fs.readFileSync(file, 'utf-8') }
    catch { warnings.push(`Could not read ${file}`); continue }
    // Many Codex builds use one file per session, named with the session id.
    const fileSession = path.basename(file).replace(/\.jsonl$/, '')

    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let obj: CodexLine
      try { obj = JSON.parse(trimmed) as CodexLine } catch { continue }
      const role = obj.role
      if (role !== 'user' && role !== 'assistant') continue
      const content = flatten(obj.content, obj.text)
      if (!content.trim()) continue
      const timestamp = obj.timestamp ?? obj.created_at ?? ''
      const ts = timestamp ? Date.parse(timestamp) : 0
      if (since > 0 && ts > 0 && ts < since) continue
      if (ts > max) max = ts
      const sessionId = obj.sessionId ?? obj.session_id ?? fileSession
      const id = obj.id ?? `${sessionId}:${bySession.get(sessionId)?.length ?? 0}`
      const arr = bySession.get(sessionId) ?? []
      arr.push({ id, role, content, timestamp, ts, sessionId })
      bySession.set(sessionId, arr)
    }
  }

  const records: ConversationRecord[] = []
  for (const [sessionId, msgs] of bySession.entries()) {
    msgs.sort((a, b) => a.ts - b.ts)
    const messages: ConversationMessage[] = msgs.map(m => ({
      id: m.id, role: m.role, content: m.content, timestamp: m.timestamp,
    }))
    records.push({
      id: `codex:${sessionId}`,
      source: 'codex',
      sessionId,
      projectPath: '',
      startedAt: msgs[0]?.timestamp ?? '',
      endedAt: msgs[msgs.length - 1]?.timestamp ?? '',
      messages,
    })
  }

  return { records, warnings, newHighWaterMark: max }
}

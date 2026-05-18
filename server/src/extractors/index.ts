import { extractClaudeConversations, extractClaudeConversationById } from './claudeCode'
import { extractCursorConversations, extractCursorConversationById } from './cursor'
import { extractCodexConversations, extractCodexConversationById } from './codex'
import { appendRecords, readSentinel, writeSentinel } from './store'
import type { ConversationRecord, ConversationSource, ExtractResult } from './types'

// Unified id format from the extractors is `<source>:<sessionId>`. The synth
// path uses this to re-pull the original conversation text for richer prompt
// context — full text held in memory only for the LLM call, never persisted.
export function extractConversationById(conversationId: string): ConversationRecord | null {
  const idx = conversationId.indexOf(':')
  if (idx === -1) return null
  const source = conversationId.slice(0, idx) as ConversationSource
  const sessionId = conversationId.slice(idx + 1)
  if (!sessionId) return null
  switch (source) {
    case 'claude': return extractClaudeConversationById(sessionId)
    case 'cursor': return extractCursorConversationById(sessionId)
    case 'codex': return extractCodexConversationById(sessionId)
    default: return null
  }
}

export interface ExtractOptions {
  /** Days to look back. Defaults to 14 (per Auto Skill decision #4). */
  lookbackDays?: number
  /** Restrict to a subset of sources. Defaults to all known sources. */
  sources?: ConversationSource[]
}

export function runExtraction(opts: ExtractOptions = {}): { results: ExtractResult[]; lastRunAt: string } {
  const lookbackDays = opts.lookbackDays ?? 14
  const sources: ConversationSource[] = opts.sources ?? ['claude', 'cursor', 'codex']

  const sentinel = readSentinel()
  const now = Date.now()
  // Per-source `since`: max(lookback window, recorded high-water mark) so we
  // never re-process a turn we already wrote, but we also never reach further
  // back than the user-asked-for window.
  const lookbackFloor = now - lookbackDays * 24 * 60 * 60 * 1000

  const results: ExtractResult[] = []
  const nextHwm: Partial<Record<ConversationSource, number>> = { ...sentinel.highWaterMark }

  for (const source of sources) {
    const hwm = sentinel.highWaterMark[source] ?? 0
    const since = Math.max(hwm, lookbackFloor)
    let records, warnings, newHwm
    if (source === 'claude') {
      ;({ records, warnings, newHighWaterMark: newHwm } = extractClaudeConversations(since))
    } else if (source === 'cursor') {
      ;({ records, warnings, newHighWaterMark: newHwm } = extractCursorConversations(since))
    } else {
      ;({ records, warnings, newHighWaterMark: newHwm } = extractCodexConversations(since))
    }
    const { added, skipped } = appendRecords(records)
    nextHwm[source] = Math.max(hwm, newHwm)
    results.push({ source, added, skipped, warnings })
  }

  const lastRunAt = new Date().toISOString()
  writeSentinel({ highWaterMark: nextHwm, lastRunAt })
  return { results, lastRunAt }
}

export { readSentinel } from './store'

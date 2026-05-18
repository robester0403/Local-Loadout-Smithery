import { extractClaudeConversations } from './claudeCode'
import { extractCursorConversations } from './cursor'
import { extractCodexConversations } from './codex'
import { appendRecords, readSentinel, writeSentinel } from './store'
import type { ConversationSource, ExtractResult } from './types'

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

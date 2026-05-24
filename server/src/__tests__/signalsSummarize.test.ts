import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { summarizeArc, parseSummary, buildPrompt, shouldFilter } from '../autoSkill/signals/summarize'
import { openSummaryCache, computeCacheKey } from '../autoSkill/signals/summaryCache'
import type { ConversationMessage, ConversationRecord } from '../extractors/types'
import type { SubGoalArc, ConversationSummary } from '../autoSkill/signals/types'

// ---- Fixtures ---------------------------------------------------------------

function msg(i: number, role: 'user' | 'assistant', content: string): ConversationMessage {
  return {
    id: `m${i}`,
    role,
    content,
    timestamp: new Date(Date.UTC(2026, 4, 23, 12, i, 0)).toISOString(),
  }
}

function convo(messages: ConversationMessage[]): ConversationRecord {
  return {
    id: 'claude:summarize-test',
    source: 'claude',
    sessionId: 'summarize-test',
    projectPath: '/work',
    startedAt: messages[0].timestamp,
    endedAt: messages[messages.length - 1].timestamp,
    messages,
  }
}

const SAMPLE_ARC: SubGoalArc = {
  conversationId: 'claude:summarize-test',
  arcId: 'claude:summarize-test#0',
  startTurnIndex: 0,
  endTurnIndex: 3,
  triggerSignal: 'conversation-start',
}

const SAMPLE_CONVO = convo([
  msg(0, 'user', 'help me write a vitest test for the foo helper'),
  msg(1, 'assistant', 'sure — here is one'),
  msg(2, 'user', 'great, now add a snapshot test'),
  msg(3, 'assistant', 'done'),
])

const GOOD_LLM_OUTPUT = JSON.stringify({
  intent: 'add tests for the foo helper',
  slotValues: {
    files: ['src/foo.ts'],
    tools: ['Read', 'Edit'],
    libraries: ['vitest'],
    mcps: [],
  },
  resolutionSteps: ['scaffold test file', 'add unit case', 'add snapshot case'],
  outcome: 'succeeded',
  stableApproach: true,
  subGoals: ['write unit test', 'add snapshot'],
  toolSignature: ['Read', 'Edit'],
  invokedSkills: [],
  verbatimUserPrompts: ['help me write a vitest test for the foo helper'],
  correctionMarkers: [],
  personalizationSignals: [{ kind: 'test-framework', evidence: 'prefers vitest' }],
})

// Path helper so each test has an isolated cache file.
let tmpDir: string
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-summarize-'))
})
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ---- parseSummary -----------------------------------------------------------

describe('parseSummary', () => {
  it('parses a well-formed JSON payload', () => {
    const s = parseSummary(GOOD_LLM_OUTPUT, SAMPLE_ARC, SAMPLE_CONVO)
    expect(s.intent).toBe('add tests for the foo helper')
    expect(s.outcome).toBe('succeeded')
    expect(s.stableApproach).toBe(true)
    expect(s.slotValues.files).toEqual(['src/foo.ts'])
    expect(s.slotValues.mcps).toEqual([])
    expect(s.personalizationSignals[0].kind).toBe('test-framework')
    expect(s.arcId).toBe(SAMPLE_ARC.arcId)
    expect(s.source).toBe('claude')
  })

  it('throws on malformed JSON', () => {
    expect(() => parseSummary('not json', SAMPLE_ARC, SAMPLE_CONVO)).toThrow(/invalid JSON/i)
  })

  it('throws on missing required string field', () => {
    const bad = JSON.parse(GOOD_LLM_OUTPUT)
    delete bad.intent
    expect(() => parseSummary(JSON.stringify(bad), SAMPLE_ARC, SAMPLE_CONVO))
      .toThrow(/missing string field 'intent'/)
  })

  it('throws on invalid outcome enum', () => {
    const bad = JSON.parse(GOOD_LLM_OUTPUT)
    bad.outcome = 'kinda-worked'
    expect(() => parseSummary(JSON.stringify(bad), SAMPLE_ARC, SAMPLE_CONVO))
      .toThrow(/invalid outcome/)
  })

  it('seeds missing slot keys with empty arrays', () => {
    const bad = JSON.parse(GOOD_LLM_OUTPUT)
    bad.slotValues = { files: ['x.ts'] } // missing tools/libraries/mcps
    const s = parseSummary(JSON.stringify(bad), SAMPLE_ARC, SAMPLE_CONVO)
    expect(s.slotValues.tools).toEqual([])
    expect(s.slotValues.libraries).toEqual([])
    expect(s.slotValues.mcps).toEqual([])
    expect(s.slotValues.files).toEqual(['x.ts'])
  })

  it('tolerates missing optional arrays (correctionMarkers / personalizationSignals)', () => {
    const bad = JSON.parse(GOOD_LLM_OUTPUT)
    delete bad.correctionMarkers
    delete bad.personalizationSignals
    const s = parseSummary(JSON.stringify(bad), SAMPLE_ARC, SAMPLE_CONVO)
    expect(s.correctionMarkers).toEqual([])
    expect(s.personalizationSignals).toEqual([])
  })

  it('drops malformed correctionMarker entries silently', () => {
    const bad = JSON.parse(GOOD_LLM_OUTPUT)
    bad.correctionMarkers = [
      { quote: 'no, do Y', kind: 'reversal' },
      { quote: 'fine', kind: 'banana' },
      'just a string',
    ]
    const s = parseSummary(JSON.stringify(bad), SAMPLE_ARC, SAMPLE_CONVO)
    expect(s.correctionMarkers).toHaveLength(1)
    expect(s.correctionMarkers[0]).toEqual({ quote: 'no, do Y', kind: 'reversal' })
  })
})

// ---- buildPrompt ------------------------------------------------------------

describe('buildPrompt', () => {
  it('includes arc range, source, and turn lines', () => {
    const p = buildPrompt(SAMPLE_ARC, SAMPLE_CONVO)
    expect(p).toContain('turns 0–3')
    expect(p).toContain('Conversation source: claude')
    expect(p).toContain('USER:')
    expect(p).toContain('ASSISTANT:')
  })

  it('truncates very long turn content', () => {
    const long = 'x'.repeat(5000)
    const c = convo([msg(0, 'user', long)])
    const p = buildPrompt({ ...SAMPLE_ARC, endTurnIndex: 0 }, c)
    expect(p).toContain('…')
    expect(p).not.toContain('x'.repeat(5000))
  })
})

// ---- shouldFilter -----------------------------------------------------------

describe('shouldFilter', () => {
  const base: ConversationSummary = {
    arcId: 'a',
    conversationId: 'c',
    source: 'claude',
    startedAt: '',
    intent: '',
    slotValues: { files: [], tools: [], libraries: [], mcps: [] },
    resolutionSteps: [],
    outcome: 'succeeded',
    stableApproach: true,
    subGoals: [],
    toolSignature: [],
    invokedSkills: [],
    verbatimUserPrompts: [],
    correctionMarkers: [],
    personalizationSignals: [],
  }

  it('drops failed + unstable arcs', () => {
    expect(shouldFilter({ ...base, outcome: 'failed', stableApproach: false })).toBe(true)
  })

  it('keeps failed + stable (still informative)', () => {
    expect(shouldFilter({ ...base, outcome: 'failed', stableApproach: true })).toBe(false)
  })

  it('keeps succeeded regardless of stability', () => {
    expect(shouldFilter({ ...base, outcome: 'succeeded', stableApproach: false })).toBe(false)
  })
})

// ---- summarizeArc end-to-end -----------------------------------------------

describe('summarizeArc', () => {
  it('writes and reuses the cache (one LLM call across two runs)', async () => {
    const cache = openSummaryCache(path.join(tmpDir, 'summaries.json'))
    let calls = 0
    const llmFn = async (): Promise<string> => {
      calls += 1
      return GOOD_LLM_OUTPUT
    }

    const first = await summarizeArc(SAMPLE_ARC, SAMPLE_CONVO, { llmFn, cache })
    expect(first?.intent).toBe('add tests for the foo helper')
    expect(calls).toBe(1)

    const second = await summarizeArc(SAMPLE_ARC, SAMPLE_CONVO, { llmFn, cache })
    expect(second?.intent).toBe('add tests for the foo helper')
    expect(calls).toBe(1) // cache hit on second call

    // Open a fresh cache pointed at the same file → still a hit, proves persistence.
    const reopened = openSummaryCache(path.join(tmpDir, 'summaries.json'))
    const third = await summarizeArc(SAMPLE_ARC, SAMPLE_CONVO, { llmFn, cache: reopened })
    expect(third?.intent).toBe('add tests for the foo helper')
    expect(calls).toBe(1)
  })

  it('filtered-out summaries do NOT pollute the cache', async () => {
    const cache = openSummaryCache(path.join(tmpDir, 'summaries.json'))
    let calls = 0
    const llmFn = async (): Promise<string> => {
      calls += 1
      return JSON.stringify({
        ...JSON.parse(GOOD_LLM_OUTPUT),
        outcome: 'failed',
        stableApproach: false,
      })
    }

    const first = await summarizeArc(SAMPLE_ARC, SAMPLE_CONVO, { llmFn, cache })
    expect(first).toBeNull()
    expect(calls).toBe(1)

    // Same arc again → no cache hit (we didn't store the null), LLM fires again.
    const second = await summarizeArc(SAMPLE_ARC, SAMPLE_CONVO, { llmFn, cache })
    expect(second).toBeNull()
    expect(calls).toBe(2)
  })

  it('propagates parse errors from a malformed LLM response', async () => {
    const cache = openSummaryCache(path.join(tmpDir, 'summaries.json'))
    const llmFn = async (): Promise<string> => 'not json at all'
    await expect(summarizeArc(SAMPLE_ARC, SAMPLE_CONVO, { llmFn, cache }))
      .rejects.toThrow(/invalid JSON/i)
  })

  it('changes in conversation content produce a different cache key', () => {
    const k1 = computeCacheKey(SAMPLE_ARC, SAMPLE_CONVO)
    const altered = convo([
      msg(0, 'user', 'completely different question'),
      msg(1, 'assistant', 'different answer'),
      msg(2, 'user', 'and a follow up'),
      msg(3, 'assistant', 'reply'),
    ])
    const k2 = computeCacheKey(SAMPLE_ARC, altered)
    expect(k1).not.toBe(k2)
  })
})

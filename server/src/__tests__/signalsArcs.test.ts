import { describe, it, expect } from 'vitest'
import { segmentIntoArcs } from '../autoSkill/signals/arcs'
import type { ConversationMessage, ConversationRecord } from '../extractors/types'

// ---- Fixture helpers --------------------------------------------------------

const BASE_TIME = Date.UTC(2026, 4, 23, 12, 0, 0)

function msg(
  i: number,
  role: 'user' | 'assistant',
  content: string,
  opts: { offsetMin?: number; cwd?: string } = {},
): ConversationMessage {
  const ts = new Date(BASE_TIME + (opts.offsetMin ?? i) * 60_000).toISOString()
  return {
    id: `m${i}`,
    role,
    content,
    timestamp: ts,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  }
}

function convo(messages: ConversationMessage[], projectPath = '/work'): ConversationRecord {
  return {
    id: 'claude:test-session',
    source: 'claude',
    sessionId: 'test-session',
    projectPath,
    startedAt: messages[0]?.timestamp ?? '',
    endedAt: messages[messages.length - 1]?.timestamp ?? '',
    messages,
  }
}

// LLM mock that throws if called — proves the heuristic path doesn't need it.
const throwingLlm = async (): Promise<number[]> => {
  throw new Error('LLM should not be called from the heuristic path')
}

// ---- Tests ------------------------------------------------------------------

describe('segmentIntoArcs — heuristic path', () => {
  it('focused single-topic conversation yields exactly one arc', async () => {
    const messages = [
      msg(0, 'user', 'help me fix this typescript error'),
      msg(1, 'assistant', 'sure, let me look'),
      msg(2, 'user', 'what does that mean'),
      msg(3, 'assistant', 'it means the type is wrong'),
    ]
    const arcs = await segmentIntoArcs(convo(messages), { llmBoundaryFn: throwingLlm })
    expect(arcs).toHaveLength(1)
    expect(arcs[0]).toMatchObject({
      startTurnIndex: 0,
      endTurnIndex: 3,
      triggerSignal: 'conversation-start',
    })
  })

  it('splits on topic-shift phrase in user message', async () => {
    const messages = [
      msg(0, 'user', 'help me fix this typescript error'),
      msg(1, 'assistant', 'sure'),
      msg(2, 'user', 'ok switching gears, write me a bash script'),
      msg(3, 'assistant', 'on it'),
    ]
    const arcs = await segmentIntoArcs(convo(messages), { llmBoundaryFn: throwingLlm })
    expect(arcs).toHaveLength(2)
    expect(arcs[1]).toMatchObject({
      startTurnIndex: 2,
      triggerSignal: 'topic-shift-phrase',
    })
  })

  it('splits on >30 min time gap', async () => {
    const messages = [
      msg(0, 'user', 'task A', { offsetMin: 0 }),
      msg(1, 'assistant', 'done A', { offsetMin: 1 }),
      msg(2, 'user', 'task B', { offsetMin: 35 }), // 34 min after prev → boundary
      msg(3, 'assistant', 'done B', { offsetMin: 36 }),
    ]
    const arcs = await segmentIntoArcs(convo(messages), { llmBoundaryFn: throwingLlm })
    expect(arcs).toHaveLength(2)
    expect(arcs[1]).toMatchObject({ startTurnIndex: 2, triggerSignal: 'time-gap' })
  })

  it('splits on sustained cwd shift', async () => {
    const messages = [
      msg(0, 'user', 'edit the server file', { cwd: '/work/server' }),
      msg(1, 'assistant', 'done', { cwd: '/work/server' }),
      msg(2, 'user', 'now update the docs', { cwd: '/work/docs' }),
      msg(3, 'assistant', 'done', { cwd: '/work/docs' }),
    ]
    const arcs = await segmentIntoArcs(convo(messages, '/work/server'), { llmBoundaryFn: throwingLlm })
    expect(arcs.length).toBeGreaterThanOrEqual(2)
    const second = arcs.find(a => a.startTurnIndex === 2)
    expect(second?.triggerSignal).toBe('tool-shift')
  })

  it('a single transient cwd blip does NOT split', async () => {
    const messages = [
      msg(0, 'user', 'edit server', { cwd: '/work/server' }),
      msg(1, 'assistant', 'ok', { cwd: '/work/server' }),
      msg(2, 'user', 'quick peek elsewhere', { cwd: '/work/other' }), // one-off
      msg(3, 'assistant', 'back', { cwd: '/work/server' }),
      msg(4, 'user', 'continue', { cwd: '/work/server' }),
    ]
    const arcs = await segmentIntoArcs(convo(messages, '/work/server'), { llmBoundaryFn: throwingLlm })
    expect(arcs).toHaveLength(1)
  })

  it('resolution-then-new-ask splits the new ask into a new arc', async () => {
    const messages = [
      msg(0, 'user', 'how do I install foo'),
      msg(1, 'assistant', 'run npm i foo'),
      msg(2, 'user', 'thanks!'),
      msg(3, 'assistant', 'np'),
      msg(4, 'user', 'how do I configure bar'),
    ]
    const arcs = await segmentIntoArcs(convo(messages), { llmBoundaryFn: throwingLlm })
    expect(arcs.length).toBeGreaterThanOrEqual(2)
    expect(arcs.some(a => a.startTurnIndex === 4)).toBe(true)
  })

  it('short conversation does not invoke LLM stage', async () => {
    const messages = [
      msg(0, 'user', 'hi'),
      msg(1, 'assistant', 'hello'),
      msg(2, 'user', 'bye'),
    ]
    // throwingLlm would throw if called, but the function should swallow and
    // return heuristic result. With a 3-turn convo the LLM stage shouldn't
    // even fire (LONG_CONVO_THRESHOLD is 40).
    const arcs = await segmentIntoArcs(convo(messages), { llmBoundaryFn: throwingLlm })
    expect(arcs).toHaveLength(1)
  })
})

describe('segmentIntoArcs — LLM-assisted path', () => {
  function buildLongAmbiguousConvo(turns = 50): ConversationRecord {
    const messages: ConversationMessage[] = []
    for (let i = 0; i < turns; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      messages.push(msg(i, role, role === 'user' ? `continue task line ${i}` : `acknowledged ${i}`, { offsetMin: i }))
    }
    return convo(messages)
  }

  it('fires LLM only when heuristics return 0 boundaries on a long convo', async () => {
    const conv = buildLongAmbiguousConvo(50)
    let called = 0
    const arcs = await segmentIntoArcs(conv, {
      llmBoundaryFn: async () => {
        called += 1
        return [10, 30]
      },
    })
    expect(called).toBe(1)
    expect(arcs.map(a => a.startTurnIndex)).toEqual([0, 10, 30])
    expect(arcs[1].triggerSignal).toBe('llm-detected')
  })

  it('LLM failure falls back to single-arc heuristic result', async () => {
    const conv = buildLongAmbiguousConvo(50)
    const arcs = await segmentIntoArcs(conv, {
      llmBoundaryFn: async () => { throw new Error('ollama down') },
    })
    expect(arcs).toHaveLength(1)
    expect(arcs[0].startTurnIndex).toBe(0)
  })

  it('LLM returning out-of-range / duplicate boundaries is sanitized', async () => {
    const conv = buildLongAmbiguousConvo(50)
    const arcs = await segmentIntoArcs(conv, {
      llmBoundaryFn: async () => [0, 10, 10, 999, 25, -3],
    })
    // Expect 0/-3/999 dropped, dup collapsed → arcs at 0, 10, 25.
    expect(arcs.map(a => a.startTurnIndex)).toEqual([0, 10, 25])
  })

  it('does NOT call LLM when heuristics already produced boundaries on a long convo', async () => {
    const messages: ConversationMessage[] = []
    for (let i = 0; i < 50; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      const content =
        i === 20 && role === 'user' ? 'ok switching gears, new topic' : `turn ${i}`
      messages.push(msg(i, role, content, { offsetMin: i }))
    }
    const conv = convo(messages)
    const arcs = await segmentIntoArcs(conv, { llmBoundaryFn: throwingLlm })
    expect(arcs.length).toBe(2)
    expect(arcs[1].startTurnIndex).toBe(20)
  })
})

describe('segmentIntoArcs — performance', () => {
  it('heuristic-only path runs under 50ms on a 200-turn conversation', async () => {
    const messages: ConversationMessage[] = []
    for (let i = 0; i < 200; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant'
      messages.push(msg(i, role, `turn ${i} doing routine work`, { offsetMin: i }))
    }
    const conv = convo(messages)
    const t0 = performance.now()
    const arcs = await segmentIntoArcs(conv, { llmBoundaryFn: throwingLlm })
    const elapsed = performance.now() - t0
    expect(arcs.length).toBeGreaterThanOrEqual(1)
    expect(elapsed).toBeLessThan(50)
  })
})

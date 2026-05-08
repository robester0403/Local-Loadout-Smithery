import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { detectActivations, ClaudeCodeActivationDetector } from '../usage/activation'
import type { SessionData, SessionTurn, SkillTokenInfo } from '../usage/activation'

let tmp: string

function write(p: string, content: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
}

function userWithSkill(skill: string, ts: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    message: {
      role: 'user',
      content: `<command-name>/${skill}</command-name>\n<command-message>${skill}</command-message>`,
    },
  })
}

function userPlain(ts: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    message: { role: 'user', content: 'just a message' },
  })
}

function assistantTurn(
  ts: string,
  cacheCreate = 0,
  cacheRead = 0,
  contextMgmt: null | object = null,
  toolUses: Array<{ name: string; input: Record<string, unknown> }> = [],
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      context_management: contextMgmt,
      content: toolUses.map(t => ({ type: 'tool_use', name: t.name, input: t.input })),
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead,
      },
    },
  })
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-activation-'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

// Helpers for SessionTurn fixtures.
function userTurn(ts: string, commandName?: string): SessionTurn {
  return {
    timestamp: ts,
    commandName,
    skillToolInvocations: [],
    isCompaction: false,
    isAssistant: false,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  }
}
function asstTurn(ts: string, opts: Partial<SessionTurn> = {}): SessionTurn {
  return {
    timestamp: ts,
    skillToolInvocations: [],
    isCompaction: false,
    isAssistant: true,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    ...opts,
  }
}

// ------------------------------------------------------------------
// Unit tests for ClaudeCodeActivationDetector (signal-based)
// ------------------------------------------------------------------

describe('ClaudeCodeActivationDetector', () => {
  const detector = new ClaudeCodeActivationDetector()

  it('attributes a slash-invoked skill on the next assistant turn', () => {
    const skills: SkillTokenInfo[] = [{ name: 'quiz', bodyTokens: 500 }]
    const session: SessionData = {
      sessionId: 'sess-1',
      turns: [
        userTurn('t1', 'quiz'),
        asstTurn('t2', { cacheCreationTokens: 500 }),
      ],
    }
    const events = detector.detect(session, skills)
    expect(events).toHaveLength(1)
    expect(events[0].injectedSkills).toEqual(['quiz'])
    expect(events[0].turnIndex).toBe(0)
  })

  it('attributes a Skill-tool invocation on the following assistant turn', () => {
    // Assistant turn N calls the Skill tool. The body lands in turn N+1's cache.
    const skills: SkillTokenInfo[] = [{ name: 'concept', bodyTokens: 750 }]
    const session: SessionData = {
      sessionId: 'sess-tool',
      turns: [
        asstTurn('t1', { skillToolInvocations: ['concept'] }),
        userTurn('t1.5'),  // tool_result
        asstTurn('t2', { cacheCreationTokens: 750 }),
      ],
    }
    const events = detector.detect(session, skills)
    expect(events).toHaveLength(1)
    expect(events[0].injectedSkills).toEqual(['concept'])
    expect(events[0].turnIndex).toBe(1)
  })

  it('does not attribute when there is no signal (no slash, no Skill tool)', () => {
    // Cache-delta heuristic is retired — auto-triggered guesses are no longer made.
    const skills: SkillTokenInfo[] = [{ name: 'concept', bodyTokens: 750 }]
    const session: SessionData = {
      sessionId: 'sess-2',
      turns: [
        userTurn('t1'),
        asstTurn('t2', { cacheCreationTokens: 750 }),
      ],
    }
    const events = detector.detect(session, skills)
    expect(events).toHaveLength(0)
  })

  it('attributes consecutive slash invocations of different skills in order', () => {
    const skills: SkillTokenInfo[] = [
      { name: 'skill-a', bodyTokens: 400 },
      { name: 'skill-b', bodyTokens: 600 },
    ]
    const session: SessionData = {
      sessionId: 'sess-3',
      turns: [
        userTurn('t1', 'skill-a'),
        asstTurn('t2', { cacheCreationTokens: 400 }),
        userTurn('t3', 'skill-b'),
        asstTurn('t4', { cacheCreationTokens: 600 }),
      ],
    }
    const events = detector.detect(session, skills)
    expect(events).toHaveLength(2)
    expect(events[0].injectedSkills).toEqual(['skill-a'])
    expect(events[0].turnIndex).toBe(0)
    expect(events[1].injectedSkills).toEqual(['skill-b'])
    expect(events[1].turnIndex).toBe(1)
  })

  it('attributes both signals when a slash command and a Skill tool fire in sequence', () => {
    // /A invokes skill A, A's body instructs Claude to call B via the Skill tool.
    // Both should be charged: A on turn 1, B on turn 2.
    const skills: SkillTokenInfo[] = [
      { name: 'A', bodyTokens: 300 },
      { name: 'B', bodyTokens: 400 },
    ]
    const session: SessionData = {
      sessionId: 'sess-chain',
      turns: [
        userTurn('t1', 'A'),
        asstTurn('t2', { cacheCreationTokens: 300, skillToolInvocations: ['B'] }),
        userTurn('t2.5'),  // tool_result for the Skill call
        asstTurn('t3', { cacheCreationTokens: 400 }),
      ],
    }
    const events = detector.detect(session, skills)
    expect(events).toHaveLength(2)
    expect(events[0].injectedSkills).toEqual(['A'])
    expect(events[1].injectedSkills).toEqual(['B'])
  })

  it('compaction clears the injected set; a re-signal re-activates the skill', () => {
    const skills: SkillTokenInfo[] = [{ name: 'morning-plan', bodyTokens: 800 }]
    const session: SessionData = {
      sessionId: 'sess-4',
      turns: [
        userTurn('t1', 'morning-plan'),
        asstTurn('t2', { cacheCreationTokens: 800 }),
        // Compaction
        asstTurn('t3', { isCompaction: true }),
        // Re-signal
        userTurn('t4', 'morning-plan'),
        asstTurn('t5', { cacheCreationTokens: 800 }),
      ],
    }
    const events = detector.detect(session, skills)
    const matched = events.filter(e => e.injectedSkills.includes('morning-plan'))
    expect(matched).toHaveLength(2)
  })

  it('does not re-attribute a skill that is already injected', () => {
    // Two slash invocations of the same skill in one session — only the first
    // creates a new cache write; the second is already cached.
    const skills: SkillTokenInfo[] = [{ name: 'review', bodyTokens: 600 }]
    const session: SessionData = {
      sessionId: 'sess-9',
      turns: [
        userTurn('t1', 'review'),
        asstTurn('t2', { cacheCreationTokens: 600 }),
        userTurn('t3', 'review'),
        asstTurn('t4', { cacheCreationTokens: 0 }),
      ],
    }
    const events = detector.detect(session, skills)
    const matched = events.filter(e => e.injectedSkills.includes('review'))
    expect(matched).toHaveLength(1)
  })

  it('ignores signals naming skills that are not in the validSkills list', () => {
    const skills: SkillTokenInfo[] = [{ name: 'real-skill', bodyTokens: 500 }]
    const session: SessionData = {
      sessionId: 'sess-unknown',
      turns: [
        userTurn('t1', 'unknown-skill'),
        asstTurn('t2', { cacheCreationTokens: 500 }),
      ],
    }
    const events = detector.detect(session, skills)
    expect(events).toHaveLength(0)
  })

  it('emits no events when there are no signals at all', () => {
    const skills: SkillTokenInfo[] = [{ name: 'tiny', bodyTokens: 50 }]
    const session: SessionData = {
      sessionId: 'sess-10',
      turns: [
        asstTurn('t1', { cacheCreationTokens: 18000 }),  // pure system content
        asstTurn('t2', { cacheCreationTokens: 200 }),    // mid-session noise
      ],
    }
    const events = detector.detect(session, skills)
    expect(events).toHaveLength(0)
  })
})

// ------------------------------------------------------------------
// Integration tests for detectActivations (reads real JSONL files)
// ------------------------------------------------------------------

describe('detectActivations (file-based)', () => {
  it('detects slash-invoked skill from JSONL', () => {
    const home = path.join(tmp, 'home-slash')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'p', 'sess-a.jsonl'),
      [
        userWithSkill('quiz', '2026-05-01T10:00:00Z'),
        assistantTurn('2026-05-01T10:00:05Z', 500, 0),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const events = detectActivations([{ name: 'quiz', bodyTokens: 500 }])
    process.env['HOME'] = orig

    expect(events).toHaveLength(1)
    expect(events[0].injectedSkills).toEqual(['quiz'])
    expect(events[0].sessionId).toBe('sess-a')
    expect(events[0].turnIndex).toBe(0)
  })

  it('detects a Skill-tool invocation from JSONL', () => {
    const home = path.join(tmp, 'home-tool')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'p', 'sess-tool.jsonl'),
      [
        userPlain('2026-05-01T10:00:00Z'),
        // Assistant calls Skill tool
        assistantTurn('2026-05-01T10:00:05Z', 0, 0, null, [
          { name: 'Skill', input: { skill: 'kibana-api' } },
        ]),
        userPlain('2026-05-01T10:00:06Z'),  // tool_result
        assistantTurn('2026-05-01T10:00:07Z', 1500, 0),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const events = detectActivations([{ name: 'kibana-api', bodyTokens: 1500 }])
    process.env['HOME'] = orig

    expect(events).toHaveLength(1)
    expect(events[0].injectedSkills).toEqual(['kibana-api'])
  })

  it('does not detect anything without an explicit signal', () => {
    const home = path.join(tmp, 'home-auto')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'p', 'sess-b.jsonl'),
      [
        userPlain('2026-05-01T10:00:00Z'),
        assistantTurn('2026-05-01T10:00:05Z', 750, 0),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const events = detectActivations([{ name: 'concept', bodyTokens: 750 }])
    process.env['HOME'] = orig

    expect(events).toHaveLength(0)
  })

  it('resets on compaction event in JSONL', () => {
    const home = path.join(tmp, 'home-compact')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'p', 'sess-c.jsonl'),
      [
        userWithSkill('review', '2026-05-01T10:00:00Z'),
        assistantTurn('2026-05-01T10:00:05Z', 400, 0),                           // first activate
        assistantTurn('2026-05-01T10:01:00Z', 0, 0, { applied_edits: [] }),      // compaction
        userWithSkill('review', '2026-05-01T10:02:00Z'),
        assistantTurn('2026-05-01T10:02:05Z', 400, 0),                           // re-activate
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const events = detectActivations([{ name: 'review', bodyTokens: 400 }])
    process.env['HOME'] = orig

    const activations = events.filter(e => e.injectedSkills.includes('review'))
    expect(activations).toHaveLength(2)
  })

  it('applies since filter to emitted events', () => {
    const home = path.join(tmp, 'home-since')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'p', 'sess-d.jsonl'),
      [
        userWithSkill('quiz', '2026-04-01T10:00:00Z'),
        assistantTurn('2026-04-01T10:00:05Z', 500, 0),  // before since
        userWithSkill('quiz', '2026-05-01T10:00:00Z'),
        assistantTurn('2026-05-01T10:00:05Z', 500, 0),  // after since (but already injected)
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const since = new Date('2026-05-01T00:00:00Z')
    const events = detectActivations([{ name: 'quiz', bodyTokens: 500 }], since)
    process.env['HOME'] = orig

    // The April activation is filtered out by since. The May one would be a
    // re-activation, but the skill is still in the injected set from April —
    // so no new event is emitted. (Compaction would clear that; absent one,
    // a single session doesn't double-attribute.)
    expect(events).toHaveLength(0)
  })
})

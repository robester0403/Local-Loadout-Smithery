import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { detectActivations, ClaudeCodeActivationDetector } from '../usage/activation'
import type { SessionData, SkillTokenInfo } from '../usage/activation'

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

function assistantTurn(ts: string, cacheCreate = 0, cacheRead = 0, contextMgmt: null | object = null): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      context_management: contextMgmt,
      content: [],
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

// ------------------------------------------------------------------
// Unit tests for ClaudeCodeActivationDetector (no file I/O)
// ------------------------------------------------------------------

describe('ClaudeCodeActivationDetector', () => {
  const detector = new ClaudeCodeActivationDetector()

  it('detects a slash-invoked skill when cc matches body tokens', () => {
    const skills: SkillTokenInfo[] = [{ name: 'quiz', bodyTokens: 500 }]
    const session: SessionData = {
      sessionId: 'sess-1',
      turns: [
        { timestamp: 't1', commandName: 'quiz', isCompaction: false, isAssistant: false, cacheCreationTokens: 0, cacheReadTokens: 0 },
        { timestamp: 't2', isCompaction: false, isAssistant: true, cacheCreationTokens: 500, cacheReadTokens: 0 },
      ],
    }
    const events = detector.detect(session, skills)
    expect(events).toHaveLength(1)
    expect(events[0].injectedSkills).toEqual(['quiz'])
    expect(events[0].turnIndex).toBe(0)
    expect(events[0].unexplainedDelta).toBe(0)
  })

  it('detects an auto-triggered skill (no slash command) via cache delta', () => {
    const skills: SkillTokenInfo[] = [{ name: 'concept', bodyTokens: 750 }]
    const session: SessionData = {
      sessionId: 'sess-2',
      turns: [
        { timestamp: 't1', isCompaction: false, isAssistant: false, cacheCreationTokens: 0, cacheReadTokens: 0 },
        { timestamp: 't2', isCompaction: false, isAssistant: true, cacheCreationTokens: 750, cacheReadTokens: 0 },
      ],
    }
    const events = detector.detect(session, skills)
    expect(events).toHaveLength(1)
    expect(events[0].injectedSkills).toEqual(['concept'])
  })

  it('detects two skills auto-triggered at different turns in order', () => {
    const skills: SkillTokenInfo[] = [
      { name: 'skill-a', bodyTokens: 400 },
      { name: 'skill-b', bodyTokens: 600 },
    ]
    const session: SessionData = {
      sessionId: 'sess-3',
      turns: [
        { timestamp: 't1', isCompaction: false, isAssistant: false, cacheCreationTokens: 0, cacheReadTokens: 0 },
        { timestamp: 't2', isCompaction: false, isAssistant: true, cacheCreationTokens: 400, cacheReadTokens: 0 },
        { timestamp: 't3', isCompaction: false, isAssistant: false, cacheCreationTokens: 0, cacheReadTokens: 0 },
        { timestamp: 't4', isCompaction: false, isAssistant: true, cacheCreationTokens: 600, cacheReadTokens: 0 },
      ],
    }
    const events = detector.detect(session, skills)
    expect(events).toHaveLength(2)
    expect(events[0].injectedSkills).toEqual(['skill-a'])
    expect(events[0].turnIndex).toBe(0)
    expect(events[1].injectedSkills).toEqual(['skill-b'])
    expect(events[1].turnIndex).toBe(1)
  })

  it('resets injected set on compaction and re-detects skills after', () => {
    const skills: SkillTokenInfo[] = [{ name: 'morning-plan', bodyTokens: 800 }]
    const session: SessionData = {
      sessionId: 'sess-4',
      turns: [
        // Initial activation
        { timestamp: 't1', isCompaction: false, isAssistant: true, cacheCreationTokens: 800, cacheReadTokens: 0 },
        // Compaction — clears injected set
        { timestamp: 't2', isCompaction: true, isAssistant: true, cacheCreationTokens: 0, cacheReadTokens: 0 },
        // Re-activation after compaction
        { timestamp: 't3', isCompaction: false, isAssistant: true, cacheCreationTokens: 800, cacheReadTokens: 0 },
      ],
    }
    const events = detector.detect(session, skills)
    // Both activations should be detected (skill was re-injected after compaction)
    const activations = events.filter(e => e.injectedSkills.includes('morning-plan'))
    expect(activations).toHaveLength(2)
  })

  it('puts an unmatched delta into unexplainedDelta and does not attribute it', () => {
    const skills: SkillTokenInfo[] = [{ name: 'tiny', bodyTokens: 50 }]
    const session: SessionData = {
      sessionId: 'sess-5',
      turns: [
        // Delta of 5000 — way bigger than tiny's body, doesn't match anything
        { timestamp: 't1', isCompaction: false, isAssistant: true, cacheCreationTokens: 5000, cacheReadTokens: 0 },
      ],
    }
    const events = detector.detect(session, skills)
    expect(events).toHaveLength(1)
    expect(events[0].injectedSkills).toHaveLength(0)
    expect(events[0].unexplainedDelta).toBe(5000)
  })

  it('attributes ambiguous single-match delta to all matches', () => {
    // Two skills with the same token count — delta matches both
    const skills: SkillTokenInfo[] = [
      { name: 'alpha', bodyTokens: 500 },
      { name: 'beta', bodyTokens: 500 },
    ]
    const session: SessionData = {
      sessionId: 'sess-6',
      turns: [
        { timestamp: 't1', isCompaction: false, isAssistant: true, cacheCreationTokens: 500, cacheReadTokens: 0 },
      ],
    }
    const events = detector.detect(session, skills)
    expect(events).toHaveLength(1)
    // Both skills attributed when ambiguous
    expect(events[0].injectedSkills).toContain('alpha')
    expect(events[0].injectedSkills).toContain('beta')
  })

  it('uses slash-command hint to disambiguate ambiguous single matches', () => {
    const skills: SkillTokenInfo[] = [
      { name: 'alpha', bodyTokens: 500 },
      { name: 'beta', bodyTokens: 500 },
    ]
    const session: SessionData = {
      sessionId: 'sess-7',
      turns: [
        { timestamp: 't1', commandName: 'beta', isCompaction: false, isAssistant: false, cacheCreationTokens: 0, cacheReadTokens: 0 },
        { timestamp: 't2', isCompaction: false, isAssistant: true, cacheCreationTokens: 500, cacheReadTokens: 0 },
      ],
    }
    const events = detector.detect(session, skills)
    expect(events).toHaveLength(1)
    expect(events[0].injectedSkills).toEqual(['beta'])
  })

  it('puts pair-sum-matching delta into unexplainedDelta (pair matching disabled in Phase 15)', () => {
    // Pair matching was disabled after a real-data spike showed high FPR.
    // A delta matching two skill bodies goes to unexplainedDelta, not attributed.
    const skills: SkillTokenInfo[] = [
      { name: 'small', bodyTokens: 300 },
      { name: 'large', bodyTokens: 700 },
    ]
    const session: SessionData = {
      sessionId: 'sess-8',
      turns: [
        // Delta = 1000 = 300 + 700, but neither single-skill matches (300 ≠ 1000, 700 ≠ 1000)
        { timestamp: 't1', isCompaction: false, isAssistant: true, cacheCreationTokens: 1000, cacheReadTokens: 0 },
      ],
    }
    const events = detector.detect(session, skills)
    expect(events).toHaveLength(1)
    expect(events[0].injectedSkills).toHaveLength(0)
    expect(events[0].unexplainedDelta).toBe(1000)
  })

  it('does not re-detect already-injected skills', () => {
    const skills: SkillTokenInfo[] = [{ name: 'review', bodyTokens: 600 }]
    const session: SessionData = {
      sessionId: 'sess-9',
      turns: [
        // First turn — activates review
        { timestamp: 't1', isCompaction: false, isAssistant: true, cacheCreationTokens: 600, cacheReadTokens: 0 },
        // Second turn — same cc value, but review is already injected; goes to unexplained
        { timestamp: 't2', isCompaction: false, isAssistant: true, cacheCreationTokens: 600, cacheReadTokens: 0 },
      ],
    }
    const events = detector.detect(session, skills)
    // Only one activation event (first turn)
    const matched = events.filter(e => e.injectedSkills.includes('review'))
    expect(matched).toHaveLength(1)
    // Second event should be unexplained
    expect(events[1].unexplainedDelta).toBe(600)
  })

  it('ignores deltas below MIN_DELTA_TOLERANCE', () => {
    const skills: SkillTokenInfo[] = [{ name: 'tiny', bodyTokens: 50 }]
    const session: SessionData = {
      sessionId: 'sess-10',
      turns: [
        // cc = 50 — below the 200-token minimum
        { timestamp: 't1', isCompaction: false, isAssistant: true, cacheCreationTokens: 50, cacheReadTokens: 0 },
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
    // Use 500 tokens — well within ±15% of the cc we'll set
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

  it('detects auto-triggered skill from JSONL', () => {
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

    expect(events).toHaveLength(1)
    expect(events[0].injectedSkills).toEqual(['concept'])
  })

  it('resets on compaction event in JSONL', () => {
    const home = path.join(tmp, 'home-compact')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'p', 'sess-c.jsonl'),
      [
        assistantTurn('2026-05-01T10:00:00Z', 400, 0),                            // activate
        assistantTurn('2026-05-01T10:01:00Z', 0, 0, { applied_edits: [] }),       // compaction
        assistantTurn('2026-05-01T10:02:00Z', 400, 0),                            // re-activate
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
        assistantTurn('2026-04-01T10:00:00Z', 500, 0),  // before since
        assistantTurn('2026-05-01T10:00:00Z', 500, 0),  // after since
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const since = new Date('2026-05-01T00:00:00Z')
    const events = detectActivations([{ name: 'quiz', bodyTokens: 500 }], since)
    process.env['HOME'] = orig

    // Only the May event should appear
    expect(events).toHaveLength(1)
    expect(events[0].timestamp).toBe('2026-05-01T10:00:00Z')
  })
})

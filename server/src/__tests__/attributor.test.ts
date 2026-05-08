import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { computeActiveCost } from '../usage/active'
import { resetPricingCache } from '../usage/pricing'

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
      content: `<command-name>/${skill}</command-name>\n<command-message>${skill}</command-message>\n<command-args></command-args>`,
    },
  })
}

function assistantTurn(ts: string, cacheCreate = 0, cacheRead = 0, output = 50, model = 'claude-sonnet-4-6'): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      role: 'assistant',
      model,
      content: [],
      usage: {
        input_tokens: 0,
        output_tokens: output,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead,
      },
    },
  })
}

function compactionTurn(ts: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [],
      context_management: { type: 'auto_compact' },
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  })
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-attr-'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  resetPricingCache()
})

describe('computeActiveCost', () => {
  it('detects skill activation when cacheCreate matches bodyTokens', () => {
    const home = path.join(tmp, 'home-basic')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess1.jsonl'),
      [
        userWithSkill('morning-plan', '2026-05-01T10:00:00Z'),
        assistantTurn('2026-05-01T10:00:05Z', 500, 0),  // cc=500 → activation
        assistantTurn('2026-05-01T10:00:10Z', 0, 0),    // subsequent → cache read
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeActiveCost([{ name: 'morning-plan', bodyBytes: 2000, bodyTokens: 500 }])
    process.env['HOME'] = orig

    expect(costs).toHaveLength(1)
    const mp = costs.find(c => c.skillName === 'morning-plan')!
    expect(mp).toBeDefined()
    expect(mp.activations).toBe(1)
    expect(mp.cacheCreationTokens).toBe(500)
    expect(mp.cacheReadTokens).toBe(500)   // second turn charges read rate
    expect(mp.activeTurns).toBe(2)
  })

  it('counts multiple activations across separate sessions', () => {
    const home = path.join(tmp, 'home-repeat')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess2a.jsonl'),
      [
        userWithSkill('quiz', '2026-05-01T10:00:00Z'),
        assistantTurn('2026-05-01T10:00:05Z', 500, 0),
      ].join('\n') + '\n',
    )
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess2b.jsonl'),
      [
        userWithSkill('quiz', '2026-05-01T10:05:00Z'),
        assistantTurn('2026-05-01T10:05:05Z', 500, 0),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeActiveCost([{ name: 'quiz', bodyBytes: 2000, bodyTokens: 500 }])
    process.env['HOME'] = orig

    const quiz = costs.find(c => c.skillName === 'quiz')!
    expect(quiz.activations).toBe(2)
    expect(quiz.cacheCreationTokens).toBe(1000)
  })

  it('tracks multiple skills activated in the same session', () => {
    const home = path.join(tmp, 'home-split')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess3.jsonl'),
      [
        userWithSkill('skill-a', '2026-05-01T10:00:00Z'),
        assistantTurn('2026-05-01T10:00:05Z', 500, 0),
        userWithSkill('skill-b', '2026-05-01T10:01:00Z'),
        assistantTurn('2026-05-01T10:01:05Z', 700, 0),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeActiveCost([
      { name: 'skill-a', bodyBytes: 2000, bodyTokens: 500 },
      { name: 'skill-b', bodyBytes: 3000, bodyTokens: 700 },
    ])
    process.env['HOME'] = orig

    const a = costs.find(c => c.skillName === 'skill-a')!
    const b = costs.find(c => c.skillName === 'skill-b')!
    expect(a.activations).toBe(1)
    expect(a.cacheCreationTokens).toBe(500)
    expect(b.activations).toBe(1)
    expect(b.cacheCreationTokens).toBe(700)
  })

  it('returns empty when no matching cacheCreate events exist', () => {
    const home = path.join(tmp, 'home-noattr')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess4.jsonl'),
      [
        assistantTurn('2026-05-01T10:00:05Z', 0, 0),  // cc=0 — no activation
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeActiveCost([{ name: 'quiz', bodyBytes: 2000, bodyTokens: 500 }])
    process.env['HOME'] = orig

    expect(costs).toHaveLength(0)
  })

  it('computes dollar costs using cache_write pricing', () => {
    const home = path.join(tmp, 'home-dollars')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess5.jsonl'),
      [
        userWithSkill('review', '2026-05-01T10:00:00Z'),
        assistantTurn('2026-05-01T10:00:05Z', 1_000_000, 0),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeActiveCost([{ name: 'review', bodyBytes: 4_000_000, bodyTokens: 1_000_000 }])
    process.env['HOME'] = orig

    const review = costs.find(c => c.skillName === 'review')!
    // Sonnet cache_write = $3.75/M → 1M tokens = $3.75
    expect(review.totalDollars).toBeCloseTo(3.75)
  })

  it('sorts results by totalDollars descending', () => {
    const home = path.join(tmp, 'home-sort')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess6.jsonl'),
      [
        userWithSkill('cheap', '2026-05-01T10:00:00Z'),
        assistantTurn('2026-05-01T10:00:05Z', 300, 0),
        userWithSkill('expensive', '2026-05-01T10:01:00Z'),
        assistantTurn('2026-05-01T10:01:05Z', 5000, 0),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeActiveCost([
      { name: 'cheap', bodyBytes: 1200, bodyTokens: 300 },
      { name: 'expensive', bodyBytes: 20000, bodyTokens: 5000 },
    ])
    process.env['HOME'] = orig

    expect(costs[0].skillName).toBe('expensive')
    expect(costs[1].skillName).toBe('cheap')
  })

  it('re-activates skills after compaction clears the cache', () => {
    const home = path.join(tmp, 'home-compaction')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess7.jsonl'),
      [
        assistantTurn('2026-05-01T10:00:00Z', 500, 0),  // activation 1
        compactionTurn('2026-05-01T10:01:00Z'),           // clears injected set
        assistantTurn('2026-05-01T10:02:00Z', 500, 0),  // activation 2
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeActiveCost([{ name: 'morning-plan', bodyBytes: 2000, bodyTokens: 500 }])
    process.env['HOME'] = orig

    const mp = costs.find(c => c.skillName === 'morning-plan')!
    expect(mp.activations).toBe(2)
    expect(mp.cacheCreationTokens).toBe(1000)
  })
})

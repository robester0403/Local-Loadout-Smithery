import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { computeActiveCost } from '../usage/attributor'
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

function userPlain(ts: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    message: { role: 'user', content: 'just a message' },
  })
}

function assistantTurn(ts: string, input = 100, output = 50): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [],
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
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
  it('attributes assistant turns to the preceding skill invocation', () => {
    const home = path.join(tmp, 'home-basic')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess1.jsonl'),
      [
        userWithSkill('morning-plan', '2026-05-01T10:00:00Z'),
        assistantTurn('2026-05-01T10:00:05Z', 100, 50),
        assistantTurn('2026-05-01T10:00:10Z', 200, 80),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeActiveCost()
    process.env['HOME'] = orig

    expect(costs).toHaveLength(1)
    const mp = costs.find(c => c.skillName === 'morning-plan')!
    expect(mp).toBeDefined()
    expect(mp.invocations).toBe(1)
    expect(mp.inputTokens).toBe(300)
    expect(mp.outputTokens).toBe(130)
  })

  it('counts invocations correctly for repeated skill use', () => {
    const home = path.join(tmp, 'home-repeat')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess2.jsonl'),
      [
        userWithSkill('quiz', '2026-05-01T10:00:00Z'),
        assistantTurn('2026-05-01T10:00:05Z'),
        userWithSkill('quiz', '2026-05-01T10:05:00Z'),
        assistantTurn('2026-05-01T10:05:05Z'),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeActiveCost()
    process.env['HOME'] = orig

    const quiz = costs.find(c => c.skillName === 'quiz')!
    expect(quiz.invocations).toBe(2)
    expect(quiz.inputTokens).toBe(200)
  })

  it('splits attribution when skills change mid-session', () => {
    const home = path.join(tmp, 'home-split')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess3.jsonl'),
      [
        userWithSkill('skill-a', '2026-05-01T10:00:00Z'),
        assistantTurn('2026-05-01T10:00:05Z', 100, 50),
        userWithSkill('skill-b', '2026-05-01T10:01:00Z'),
        assistantTurn('2026-05-01T10:01:05Z', 200, 80),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeActiveCost()
    process.env['HOME'] = orig

    const a = costs.find(c => c.skillName === 'skill-a')!
    const b = costs.find(c => c.skillName === 'skill-b')!
    expect(a.inputTokens).toBe(100)
    expect(b.inputTokens).toBe(200)
  })

  it('ignores assistant turns with no preceding skill invocation', () => {
    const home = path.join(tmp, 'home-noattr')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess4.jsonl'),
      [
        userPlain('2026-05-01T10:00:00Z'),
        assistantTurn('2026-05-01T10:00:05Z'),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeActiveCost()
    process.env['HOME'] = orig

    expect(costs).toHaveLength(0)
  })

  it('computes dollar costs using pricing table', () => {
    const home = path.join(tmp, 'home-dollars')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess5.jsonl'),
      [
        userWithSkill('review', '2026-05-01T10:00:00Z'),
        // 1M input tokens at $3/M = $3, 1M output at $15/M = $15
        assistantTurn('2026-05-01T10:00:05Z', 1_000_000, 1_000_000),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeActiveCost()
    process.env['HOME'] = orig

    const review = costs.find(c => c.skillName === 'review')!
    expect(review.totalDollars).toBeCloseTo(18.00)
  })

  it('results are sorted by totalDollars descending', () => {
    const home = path.join(tmp, 'home-sort')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess6.jsonl'),
      [
        userWithSkill('cheap', '2026-05-01T10:00:00Z'),
        assistantTurn('2026-05-01T10:00:05Z', 100, 10),
        userWithSkill('expensive', '2026-05-01T10:01:00Z'),
        assistantTurn('2026-05-01T10:01:05Z', 1_000_000, 1_000_000),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeActiveCost()
    process.env['HOME'] = orig

    expect(costs[0].skillName).toBe('expensive')
    expect(costs[1].skillName).toBe('cheap')
  })
})

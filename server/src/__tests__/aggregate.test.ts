import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { computeSkillAggregate } from '../usage/aggregate'
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

function assistantTurn(ts: string, input = 0, output = 0, cacheCreate = 0, cacheRead = 0): string {
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
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead,
      },
    },
  })
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-agg-'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  resetPricingCache()
})

describe('computeSkillAggregate', () => {
  it('merges active and loaded cost for the same skill', () => {
    const home = path.join(tmp, 'home-merge')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    // Turn 1: skill is invoked (active) + loaded (passive)
    // Turn 2: skill is NOT invoked but still loaded
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      [
        userWithSkill('quiz', '2026-05-01T10:00:00Z'),
        assistantTurn('2026-05-01T10:00:05Z', 500, 200, 0, 0),
        assistantTurn('2026-05-01T10:01:00Z', 300, 100, 0, 0),
      ].join('\n') + '\n',
    )

    const skills = [{ name: 'quiz', description: 'a quiz skill' }]
    const orig = process.env['HOME']
    process.env['HOME'] = home
    const result = computeSkillAggregate(skills)
    process.env['HOME'] = orig

    expect(result).toHaveLength(1)
    const quiz = result[0]
    expect(quiz.skillName).toBe('quiz')
    expect(quiz.invocations).toBe(1)

    // Active: both turns attributed (attributor walks until skill changes)
    expect(quiz.active.tokens).toBeGreaterThan(0)
    expect(quiz.active.dollars).toBeGreaterThan(0)

    // Loaded: both turns proportional (only skill, 100% share)
    expect(quiz.loaded.tokens).toBeGreaterThan(0)
    expect(quiz.loaded.dollars).toBeGreaterThan(0)

    // Total must equal sum of axes
    expect(quiz.total.tokens).toBeCloseTo(quiz.active.tokens + quiz.loaded.tokens)
    expect(quiz.total.dollars).toBeCloseTo(quiz.active.dollars + quiz.loaded.dollars)
  })

  it('includes skills with loaded cost but zero active cost', () => {
    const home = path.join(tmp, 'home-loadonly')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    // No skill invocations — just passive turns
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      [
        assistantTurn('2026-05-01T10:00:00Z', 1000, 100, 0, 0),
      ].join('\n') + '\n',
    )

    const skills = [{ name: 'passive', description: 'always here' }]
    const orig = process.env['HOME']
    process.env['HOME'] = home
    const result = computeSkillAggregate(skills)
    process.env['HOME'] = orig

    expect(result).toHaveLength(1)
    expect(result[0].active.tokens).toBe(0)
    expect(result[0].active.dollars).toBe(0)
    // Loaded tokens = listing tokens for this skill (capped, 4 bytes/token).
    // 'passive always here' = 19 bytes → 4.75 tokens
    const expectedLoadedTokens = Buffer.byteLength('passive always here', 'utf-8') / 4
    expect(result[0].loaded.tokens).toBeCloseTo(expectedLoadedTokens)
    expect(result[0].invocations).toBe(0)
  })

  it('includes skills with active cost but zero metadata bytes (no loaded cost)', () => {
    const home = path.join(tmp, 'home-activeonly')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      [
        userWithSkill('ghost', '2026-05-01T10:00:00Z'),
        assistantTurn('2026-05-01T10:00:05Z', 500, 200, 0, 0),
      ].join('\n') + '\n',
    )

    // A name of '' with no description → 'Buffer.byteLength(" ")' = 1 byte, still > 0.
    // To get truly zero loaded cost, pass type: 'command' so it's filtered out.
    const skills = [{ name: 'ghost', description: undefined, type: 'command' as const }]
    const orig = process.env['HOME']
    process.env['HOME'] = home
    const result = computeSkillAggregate(skills)
    process.env['HOME'] = orig

    // Active entry exists, loaded returns empty (commands excluded from loaded)
    expect(result).toHaveLength(1)
    expect(result[0].active.tokens).toBeGreaterThan(0)
    expect(result[0].loaded.tokens).toBe(0)
    expect(result[0].total.tokens).toBe(result[0].active.tokens)
  })

  it('returns empty when no skills provided', () => {
    const home = path.join(tmp, 'home-empty')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      [assistantTurn('2026-05-01T10:00:00Z', 1000, 100, 0, 0)].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const result = computeSkillAggregate([])
    process.env['HOME'] = orig

    expect(result).toHaveLength(0)
  })

  it('sorts by total.dollars descending', () => {
    const home = path.join(tmp, 'home-sort')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      [
        // big gets far more input tokens
        assistantTurn('2026-05-01T10:00:00Z', 1_000_000, 0, 0, 0),
      ].join('\n') + '\n',
    )

    const skills = [
      { name: 'tiny', description: 'x' },
      { name: 'big',  description: 'x'.repeat(990) },
    ]
    const orig = process.env['HOME']
    process.env['HOME'] = home
    const result = computeSkillAggregate(skills)
    process.env['HOME'] = orig

    expect(result[0].skillName).toBe('big')
    expect(result[1].skillName).toBe('tiny')
    expect(result[0].total.dollars).toBeGreaterThan(result[1].total.dollars)
  })

  it('bodyBytes and loadedTurns are populated from loaded cost', () => {
    const home = path.join(tmp, 'home-meta')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      [
        assistantTurn('2026-05-01T10:00:00Z', 500, 50, 0, 0),
        assistantTurn('2026-05-01T10:01:00Z', 500, 50, 0, 0),
      ].join('\n') + '\n',
    )

    const desc = 'my description'
    const orig = process.env['HOME']
    process.env['HOME'] = home
    const result = computeSkillAggregate([{ name: 'tracked', description: desc }])
    process.env['HOME'] = orig

    const expectedBytes = Buffer.byteLength(`tracked ${desc}`, 'utf-8')
    expect(result[0].bodyBytes).toBe(expectedBytes)
    expect(result[0].loadedTurns).toBe(2)
  })
})

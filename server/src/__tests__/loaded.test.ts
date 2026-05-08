import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { computeLoadedCost, listingTokensFor, listingBytesFor } from '../usage/loaded'
import { resetPricingCache } from '../usage/pricing'

let tmp: string

function write(p: string, content: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
}

function assistantTurn(
  ts: string,
  input = 0,
  output = 0,
  cacheCreate = 0,
  cacheRead = 0,
  model = 'claude-sonnet-4-6',
  sessionId?: string,
): string {
  const obj: Record<string, unknown> = {
    type: 'assistant',
    timestamp: ts,
    message: {
      role: 'assistant',
      model,
      content: [],
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead,
      },
    },
  }
  if (sessionId !== undefined) obj['sessionId'] = sessionId
  return JSON.stringify(obj)
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-loaded-'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  resetPricingCache()
})

function listingTokens(name: string, description = ''): number {
  return listingTokensFor(name, description)
}

describe('computeLoadedCost', () => {
  it('attributes a slice of input proportional to listing-token share', () => {
    const home = path.join(tmp, 'home-single')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      [
        assistantTurn('2026-05-01T10:00:00Z', 1000, 200, 0, 0),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const desc = 'a skill description'
    const costs = computeLoadedCost([{ name: 'only-skill', description: desc }])
    process.env['HOME'] = orig

    const expectedBytes = listingBytesFor('only-skill', desc)
    expect(costs).toHaveLength(1)
    expect(costs[0].skillName).toBe('only-skill')
    // First (and only) turn → charged at cache_write rate → cacheCreationTokens
    expect(costs[0].cacheCreationTokens).toBeCloseTo(listingTokens('only-skill', desc))
    expect(costs[0].loadedTurns).toBe(1)
    expect(costs[0].listingBytes).toBe(expectedBytes)
  })

  it('splits a turn proportionally across multiple loaded skills by metadata bytes', () => {
    const home = path.join(tmp, 'home-multi')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      [
        assistantTurn('2026-05-01T10:00:00Z', 1000, 200, 0, 0),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeLoadedCost([
      { name: 'a', description: '' },
      { name: 'bbb', description: '' },
    ])
    process.env['HOME'] = orig

    const a = costs.find(c => c.skillName === 'a')!
    const bbb = costs.find(c => c.skillName === 'bbb')!
    // Each skill gets its own listing tokens charged independently — not a shared split.
    expect(a.cacheCreationTokens).toBeCloseTo(listingTokens('a'))
    expect(bbb.cacheCreationTokens).toBeCloseTo(listingTokens('bbb'))
  })

  it('counts cache reads as a real cost', () => {
    const home = path.join(tmp, 'home-cache')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    // Two turns in same session: first → cache_write rate, second → cache_read rate
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      [
        assistantTurn('2026-05-01T10:00:00Z', 1000, 50, 0, 0, 'claude-sonnet-4-6', 'ses-A'),
        assistantTurn('2026-05-01T10:01:00Z', 500, 50, 0, 0, 'claude-sonnet-4-6', 'ses-A'),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeLoadedCost([{ name: 'sole', description: 'desc' }])
    process.env['HOME'] = orig

    const skTokens = listingTokens('sole', 'desc')
    expect(costs).toHaveLength(1)
    expect(costs[0].cacheCreationTokens).toBeCloseTo(skTokens)   // first turn: write rate
    expect(costs[0].cacheReadTokens).toBeCloseTo(skTokens)       // second turn: read rate
    // Sonnet: write $3.75/M, read $0.30/M
    expect(costs[0].totalDollars).toBeCloseTo((skTokens * 3.75 + skTokens * 0.30) / 1_000_000)
  })

  it('skips turns with zero input-side tokens', () => {
    const home = path.join(tmp, 'home-empty')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      [
        assistantTurn('2026-05-01T10:00:00Z', 0, 100, 0, 0),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeLoadedCost([{ name: 'idle', description: 'desc' }])
    process.env['HOME'] = orig

    expect(costs).toHaveLength(0)
  })

  it('returns empty when no skills are loaded', () => {
    const home = path.join(tmp, 'home-noskills')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      [
        assistantTurn('2026-05-01T10:00:00Z', 1000, 100, 0, 0),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costsEmpty = computeLoadedCost([])
    process.env['HOME'] = orig

    expect(costsEmpty).toHaveLength(0)
  })

  it('aggregates loaded turns across multiple sessions', () => {
    const home = path.join(tmp, 'home-multisess')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'a.jsonl'),
      [
        assistantTurn('2026-05-01T10:00:00Z', 500, 50, 0, 0),
        assistantTurn('2026-05-01T10:01:00Z', 500, 50, 0, 0),
      ].join('\n') + '\n',
    )
    write(
      path.join(home, '.claude', 'projects', 'proj', 'b.jsonl'),
      [
        assistantTurn('2026-05-02T10:00:00Z', 1000, 100, 0, 0),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeLoadedCost([{ name: 'sole', description: 'desc' }])
    process.env['HOME'] = orig

    expect(costs).toHaveLength(1)
    expect(costs[0].loadedTurns).toBe(3)
    // All 3 turns have no sessionId → all treated as first-turn → cacheCreationTokens
    expect(costs[0].cacheCreationTokens).toBeCloseTo(3 * listingTokens('sole', 'desc'))
  })

  it('sorts results by totalDollars descending', () => {
    const home = path.join(tmp, 'home-sort')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      [
        assistantTurn('2026-05-01T10:00:00Z', 1_000_000, 0, 0, 0),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeLoadedCost([
      { name: 'tiny', description: 'x' },
      { name: 'huge', description: 'x'.repeat(990) },
    ])
    process.env['HOME'] = orig

    expect(costs[0].skillName).toBe('huge')
    expect(costs[1].skillName).toBe('tiny')
  })

  it('excludes commands from loaded cost (only injected on /invoke)', () => {
    const home = path.join(tmp, 'home-cmd-excluded')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      [
        assistantTurn('2026-05-01T10:00:00Z', 1000, 100, 0, 0),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeLoadedCost([
      { name: 'real-skill', description: 'aaaa', type: 'skill' },
      { name: 'a-command',  description: 'x'.repeat(900), type: 'command' },
      { name: 'a-subagent', description: 'aaaa', type: 'subagent' },
    ])
    process.env['HOME'] = orig

    const names = costs.map(c => c.skillName).sort()
    expect(names).toEqual(['a-subagent', 'real-skill'])
    // Command bytes don't appear in the listing — skill + subagent each get only
    // their own listing tokens attributed.
    const skill = costs.find(c => c.skillName === 'real-skill')!
    const subagent = costs.find(c => c.skillName === 'a-subagent')!
    expect(skill.cacheCreationTokens).toBeCloseTo(listingTokens('real-skill', 'aaaa'))
    expect(subagent.cacheCreationTokens).toBeCloseTo(listingTokens('a-subagent', 'aaaa'))
  })

  it('handles malformed JSONL lines without crashing', () => {
    const home = path.join(tmp, 'home-bad')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      [
        '{not valid json',
        assistantTurn('2026-05-01T10:00:00Z', 500, 50, 0, 0),
        '{also broken',
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeLoadedCost([{ name: 'sole', description: 'desc' }])
    process.env['HOME'] = orig

    expect(costs).toHaveLength(1)
    expect(costs[0].cacheCreationTokens).toBeCloseTo(listingTokens('sole', 'desc'))
  })

  it('scales attribution down proportionally when listing exceeds the 8000-byte budget', () => {
    const home = path.join(tmp, 'home-budget')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      [
        assistantTurn('2026-05-01T10:00:00Z', 1_000_000, 0, 0, 0),
      ].join('\n') + '\n',
    )

    // 6 skills with very long descriptions push raw listing past 8000 bytes.
    // Each desc is 6000 bytes → capped at 1536, so per-skill listingBytes = name + 1 + 1536.
    const skills = Array.from({ length: 6 }, (_, i) => ({
      name: `s${i}`,
      description: 'x'.repeat(6000),
    }))

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeLoadedCost(skills)
    process.env['HOME'] = orig

    // Scale factor is computed in bytes; attribution is in tokens.
    const rawBytesPerSkill = listingBytesFor('s0', 'x'.repeat(6000))
    const rawTotalBytes = rawBytesPerSkill * 6
    const effectiveScale = 8000 / rawTotalBytes
    const rawTokensPerSkill = listingTokens('s0', 'x'.repeat(6000))
    const expectedTokensPerSkill = rawTokensPerSkill * effectiveScale

    expect(costs).toHaveLength(6)
    for (const c of costs) {
      expect(c.cacheCreationTokens).toBeCloseTo(expectedTokensPerSkill, 1)
    }
    const totalAttributed = costs.reduce((sum, c) => sum + c.cacheCreationTokens, 0)
    expect(totalAttributed).toBeCloseTo(6 * expectedTokensPerSkill, 0)
  })
})

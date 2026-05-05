import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { computeLoadedCost } from '../usage/loaded'
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
): string {
  return JSON.stringify({
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
  })
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

// Listing layout matches loaded.ts: name + ' ' + description, capped per skill,
// then total budget cap of 8000, converted at 4 bytes/token.
const BYTES_PER_TOKEN = 4

function listingTokens(name: string, description = ''): number {
  return (Buffer.byteLength(`${name} ${description}`, 'utf-8')) / BYTES_PER_TOKEN
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

    const expectedBytes = Buffer.byteLength(`only-skill ${desc}`, 'utf-8')
    expect(costs).toHaveLength(1)
    expect(costs[0].skillName).toBe('only-skill')
    // Skill listing tokens this turn, capped at the actual billed input.
    expect(costs[0].inputTokens).toBeCloseTo(listingTokens('only-skill', desc))
    expect(costs[0].loadedTurns).toBe(1)
    expect(costs[0].bodyBytes).toBe(expectedBytes)
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
      { name: 'a', description: '' },   // 'a ' = 2 bytes
      { name: 'bbb', description: '' }, // 'bbb ' = 4 bytes
    ])
    process.env['HOME'] = orig

    const a = costs.find(c => c.skillName === 'a')!
    const bbb = costs.find(c => c.skillName === 'bbb')!
    // Each skill is attributed only its own listing tokens, not the full input.
    expect(a.inputTokens).toBeCloseTo(listingTokens('a'))
    expect(bbb.inputTokens).toBeCloseTo(listingTokens('bbb'))
    // Proportional split is preserved: 2:4
    expect(a.inputTokens / bbb.inputTokens).toBeCloseTo(2 / 4)
  })

  it('counts cache reads as a real cost', () => {
    const home = path.join(tmp, 'home-cache')
    write(path.join(home, '.claude', 'settings.json'), '{}')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess.jsonl'),
      [
        // No fresh input — context entirely served from cache
        assistantTurn('2026-05-01T10:00:00Z', 0, 50, 0, 1_000_000),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeLoadedCost([{ name: 'sole', description: 'desc' }])
    process.env['HOME'] = orig

    expect(costs).toHaveLength(1)
    // Skill is attributed only its share of the cache_read bucket: listing_tokens
    // out of 1M total billed.
    const skTokens = listingTokens('sole', 'desc')
    expect(costs[0].cacheReadTokens).toBeCloseTo(skTokens)
    // Sonnet cache read $0.30 / M → skTokens × 0.30 / 1M
    expect(costs[0].totalDollars).toBeCloseTo((skTokens * 0.30) / 1_000_000)
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
    // Per turn the skill is attributed listingTokens('sole','desc'), summed across 3 turns.
    expect(costs[0].inputTokens).toBeCloseTo(3 * listingTokens('sole', 'desc'))
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
    // 'tiny' has short description (few bytes), 'huge' has long description (many bytes)
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

    // Give real-skill and a-subagent identical metadata bytes so they split 50/50
    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeLoadedCost([
      { name: 'real-skill', description: 'aaaa', type: 'skill' },   // same desc length
      { name: 'a-command',  description: 'x'.repeat(900), type: 'command' },
      { name: 'a-subagent', description: 'aaaa', type: 'subagent' }, // same desc length
    ])
    process.env['HOME'] = orig

    const names = costs.map(c => c.skillName).sort()
    expect(names).toEqual(['a-subagent', 'real-skill'])
    // Command bytes don't appear in the listing — skill + subagent each get only
    // their own listing tokens attributed.
    const skill = costs.find(c => c.skillName === 'real-skill')!
    const subagent = costs.find(c => c.skillName === 'a-subagent')!
    expect(skill.inputTokens).toBeCloseTo(listingTokens('real-skill', 'aaaa'))
    expect(subagent.inputTokens).toBeCloseTo(listingTokens('a-subagent', 'aaaa'))
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
    expect(costs[0].inputTokens).toBeCloseTo(listingTokens('sole', 'desc'))
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

    // Two skills with very long descriptions push raw listing past 8000 bytes.
    // Each desc is 6000 bytes → capped at 1536, so per-skill listingBytes ≈ 1547.
    // Total raw ≈ 3094 (still under budget) — instead, give 6 such skills:
    // 6 × 1547 ≈ 9282 raw → effectiveScale = 8000 / 9282 ≈ 0.862
    const skills = Array.from({ length: 6 }, (_, i) => ({
      name: `s${i}`,
      description: 'x'.repeat(6000),
    }))

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeLoadedCost(skills)
    process.env['HOME'] = orig

    // Each skill's raw listing bytes after per-skill cap.
    const rawPerSkill = Buffer.byteLength('s0', 'utf-8') + 1 + 1536
    const rawTotal = rawPerSkill * 6
    const effectiveScale = 8000 / rawTotal
    const expectedTokensPerSkill = (rawPerSkill * effectiveScale) / 4

    expect(costs).toHaveLength(6)
    for (const c of costs) {
      expect(c.inputTokens).toBeCloseTo(expectedTokensPerSkill, 1)
    }
    // Total attributed across all skills ≤ 8000 bytes / 4 = 2000 tokens
    const totalAttributed = costs.reduce((sum, c) => sum + c.inputTokens, 0)
    expect(totalAttributed).toBeLessThanOrEqual(2000 + 1)
  })
})

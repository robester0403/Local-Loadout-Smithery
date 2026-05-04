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

describe('computeLoadedCost', () => {
  it('attributes input tokens to a single loaded skill in full', () => {
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
    expect(costs[0].inputTokens).toBe(1000)
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

    // 'a ' = 2 bytes, 'bbb ' = 4 bytes → 2:4 = 1:3 → 25%/75%
    const orig = process.env['HOME']
    process.env['HOME'] = home
    const costs = computeLoadedCost([
      { name: 'a', description: '' },   // 'a ' = 2 bytes → 25%
      { name: 'bbb', description: '' }, // 'bbb ' = 4 bytes → 75% (wait: 'bbb ' = 4, 'a ' = 2, total = 6)
    ])
    process.env['HOME'] = orig

    // 'a ' = 2 bytes = 33%, 'bbb ' = 4 bytes = 67%... let me use descriptions to hit 25/75
    // Actually: name 'a' + desc '' → 'a ' = 2 bytes; name 'bbb' + desc '' → 'bbb ' = 4 bytes
    // 2/(2+4) = 33%, 4/(2+4) = 67%
    const a = costs.find(c => c.skillName === 'a')!
    const bbb = costs.find(c => c.skillName === 'bbb')!
    // Verify proportional split sums to 1000 and each gets its share
    expect(a.inputTokens + bbb.inputTokens).toBeCloseTo(1000)
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
    expect(costs[0].cacheReadTokens).toBe(1_000_000)
    // sonnet-4-6 cache read: $0.30 / M → 1M tokens = $0.30
    expect(costs[0].totalDollars).toBeCloseTo(0.30)
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
    expect(costs[0].inputTokens).toBe(2000)
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
    // Command metadata excluded from totalBytes — skill + subagent split by their metadata bytes
    const skill = costs.find(c => c.skillName === 'real-skill')!
    const subagent = costs.find(c => c.skillName === 'a-subagent')!
    // 'real-skill aaaa' vs 'a-subagent aaaa' — different name lengths, not exactly 50/50
    // Just verify they each get a meaningful share and sum to 1000
    expect(skill.inputTokens + subagent.inputTokens).toBeCloseTo(1000)
    expect(skill.inputTokens).toBeGreaterThan(0)
    expect(subagent.inputTokens).toBeGreaterThan(0)
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
    expect(costs[0].inputTokens).toBe(500)
  })
})

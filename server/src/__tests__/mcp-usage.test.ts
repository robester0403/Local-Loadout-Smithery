import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { computeMCPUsage, computeMCPRelationships } from '../mcp/usage'
import { resetPricingCache } from '../usage/pricing'

const ALL_SKILLS = new Set(['morning-plan', 'quiz', 'review', 'skill-a', 'skill-b'])

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

function assistantWithMCP(ts: string, tools: string[], input = 100, output = 50): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: tools.map(name => ({ type: 'tool_use', name })),
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  })
}

function assistantNoMCP(ts: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'tool_use', name: 'Bash' }],
      usage: { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  })
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-mcp-usage-'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  resetPricingCache()
})

describe('computeMCPUsage', () => {
  it('counts invocations and tools for a basic MCP turn', () => {
    const home = path.join(tmp, 'home-basic')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess1.jsonl'),
      [
        assistantWithMCP('2026-05-01T10:00:00Z', ['mcp__google-calendar__create-event']),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const summaries = computeMCPUsage(undefined, ALL_SKILLS)
    process.env['HOME'] = orig

    expect(summaries).toHaveLength(1)
    expect(summaries[0].serverName).toBe('google-calendar')
    expect(summaries[0].invocations).toBe(1)
    expect(summaries[0].tools).toHaveLength(1)
    expect(summaries[0].tools[0].name).toBe('create-event')
    expect(summaries[0].tools[0].calls).toBe(1)
  })

  it('deduplicates server invocations within a single turn', () => {
    const home = path.join(tmp, 'home-dedup')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess2.jsonl'),
      [
        assistantWithMCP('2026-05-01T10:00:00Z', [
          'mcp__google-calendar__create-event',
          'mcp__google-calendar__list-events',
        ]),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const summaries = computeMCPUsage(undefined, ALL_SKILLS)
    process.env['HOME'] = orig

    expect(summaries).toHaveLength(1)
    expect(summaries[0].invocations).toBe(1)
    expect(summaries[0].tools).toHaveLength(2)
    // Both tools counted individually
    const create = summaries[0].tools.find(t => t.name === 'create-event')!
    const list = summaries[0].tools.find(t => t.name === 'list-events')!
    expect(create.calls).toBe(1)
    expect(list.calls).toBe(1)
  })

  it('handles multi-server turns — attributes cost to each server', () => {
    const home = path.join(tmp, 'home-multiserver')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess3.jsonl'),
      [
        assistantWithMCP('2026-05-01T10:00:00Z', [
          'mcp__google-calendar__list-events',
          'mcp__github__list-prs',
        ], 1_000_000, 1_000_000),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const summaries = computeMCPUsage(undefined, ALL_SKILLS)
    process.env['HOME'] = orig

    expect(summaries).toHaveLength(2)
    const cal = summaries.find(s => s.serverName === 'google-calendar')!
    const gh = summaries.find(s => s.serverName === 'github')!
    expect(cal).toBeDefined()
    expect(gh).toBeDefined()
    // Full turn cost attributed to both
    expect(cal.dollars).toBeCloseTo(gh.dollars)
    expect(cal.dollars).toBeGreaterThan(0)
  })

  it('filters by since date', () => {
    const home = path.join(tmp, 'home-since')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess4.jsonl'),
      [
        assistantWithMCP('2026-01-01T00:00:00Z', ['mcp__google-calendar__create-event']),
        assistantWithMCP('2026-05-01T10:00:00Z', ['mcp__github__list-prs']),
      ].join('\n') + '\n',
    )

    const since = new Date('2026-03-01T00:00:00Z')
    const orig = process.env['HOME']
    process.env['HOME'] = home
    const summaries = computeMCPUsage(since, ALL_SKILLS)
    process.env['HOME'] = orig

    expect(summaries).toHaveLength(1)
    expect(summaries[0].serverName).toBe('github')
  })

  it('ignores non-MCP tool_use blocks', () => {
    const home = path.join(tmp, 'home-nonmcp')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess5.jsonl'),
      [assistantNoMCP('2026-05-01T10:00:00Z')].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const summaries = computeMCPUsage(undefined, ALL_SKILLS)
    process.env['HOME'] = orig

    expect(summaries).toHaveLength(0)
  })

  it('sorts results by dollars descending', () => {
    const home = path.join(tmp, 'home-sort')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess6.jsonl'),
      [
        assistantWithMCP('2026-05-01T10:00:00Z', ['mcp__cheap__tool'], 100, 10),
        assistantWithMCP('2026-05-01T10:01:00Z', ['mcp__expensive__tool'], 1_000_000, 1_000_000),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const summaries = computeMCPUsage(undefined, ALL_SKILLS)
    process.env['HOME'] = orig

    expect(summaries[0].serverName).toBe('expensive')
    expect(summaries[1].serverName).toBe('cheap')
  })
})

describe('computeMCPRelationships', () => {
  it('attributes MCP calls to the active skill', () => {
    const home = path.join(tmp, 'home-rel-basic')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess7.jsonl'),
      [
        userWithSkill('morning-plan', '2026-05-01T10:00:00Z'),
        assistantWithMCP('2026-05-01T10:00:05Z', ['mcp__google-calendar__list-events']),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const rels = computeMCPRelationships(undefined, ALL_SKILLS)
    process.env['HOME'] = orig

    expect(rels).toHaveLength(1)
    expect(rels[0].skillName).toBe('morning-plan')
    expect(rels[0].serverName).toBe('google-calendar')
    expect(rels[0].calls).toBe(1)
  })

  it('does not attribute MCP calls when no skill is active', () => {
    const home = path.join(tmp, 'home-rel-noattr')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess8.jsonl'),
      [
        assistantWithMCP('2026-05-01T10:00:00Z', ['mcp__google-calendar__list-events']),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const rels = computeMCPRelationships(undefined, ALL_SKILLS)
    process.env['HOME'] = orig

    expect(rels).toHaveLength(0)
  })

  it('resets currentSkill to null on unknown command', () => {
    const home = path.join(tmp, 'home-rel-reset')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess9.jsonl'),
      [
        userWithSkill('morning-plan', '2026-05-01T10:00:00Z'),
        assistantWithMCP('2026-05-01T10:00:05Z', ['mcp__google-calendar__list-events']),
        userWithSkill('model', '2026-05-01T10:01:00Z'),   // unknown — not in ALL_SKILLS
        assistantWithMCP('2026-05-01T10:01:05Z', ['mcp__github__list-prs']),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const rels = computeMCPRelationships(undefined, ALL_SKILLS)
    process.env['HOME'] = orig

    // Only the first turn attributed to morning-plan; second has null currentSkill
    expect(rels).toHaveLength(1)
    expect(rels[0].skillName).toBe('morning-plan')
    expect(rels[0].serverName).toBe('google-calendar')
  })

  it('accumulates calls across multiple turns for the same skill+server pair', () => {
    const home = path.join(tmp, 'home-rel-accum')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess10.jsonl'),
      [
        userWithSkill('quiz', '2026-05-01T10:00:00Z'),
        assistantWithMCP('2026-05-01T10:00:05Z', ['mcp__google-calendar__list-events']),
        assistantWithMCP('2026-05-01T10:00:10Z', ['mcp__google-calendar__create-event']),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const rels = computeMCPRelationships(undefined, ALL_SKILLS)
    process.env['HOME'] = orig

    expect(rels).toHaveLength(1)
    expect(rels[0].skillName).toBe('quiz')
    expect(rels[0].serverName).toBe('google-calendar')
    expect(rels[0].calls).toBe(2)
  })

  it('sorts results by calls descending', () => {
    const home = path.join(tmp, 'home-rel-sort')
    write(
      path.join(home, '.claude', 'projects', 'proj', 'sess11.jsonl'),
      [
        userWithSkill('skill-a', '2026-05-01T10:00:00Z'),
        assistantWithMCP('2026-05-01T10:00:05Z', ['mcp__github__list-prs']),
        assistantWithMCP('2026-05-01T10:00:10Z', ['mcp__github__list-prs']),
        assistantWithMCP('2026-05-01T10:00:15Z', ['mcp__github__list-prs']),
        userWithSkill('skill-b', '2026-05-01T10:01:00Z'),
        assistantWithMCP('2026-05-01T10:01:05Z', ['mcp__github__list-prs']),
      ].join('\n') + '\n',
    )

    const orig = process.env['HOME']
    process.env['HOME'] = home
    const rels = computeMCPRelationships(undefined, ALL_SKILLS)
    process.env['HOME'] = orig

    expect(rels[0].skillName).toBe('skill-a')
    expect(rels[0].calls).toBe(3)
    expect(rels[1].skillName).toBe('skill-b')
    expect(rels[1].calls).toBe(1)
  })
})

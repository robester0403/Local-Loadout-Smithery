import { describe, it, expect } from 'vitest'
import { rankCandidates, __test as rankTest } from '../autoSkill/signals/rank'
import type { Candidate } from '../autoSkill/types'
import type { ConversationSummary, IntentCluster } from '../autoSkill/signals/types'

type Gen = Omit<Candidate, 'id' | 'status' | 'createdAt' | 'updatedAt'>

const NOW = Date.UTC(2026, 4, 23)

function skillCand(
  name: string,
  opts: { clusterId?: string; refCount?: number; refDate?: string } = {},
): Gen {
  const refCount = opts.refCount ?? 3
  const refDate = opts.refDate ?? '2026-05-20T00:00:00.000Z'
  return {
    signature: `skill::${name}`,
    name,
    description: name,
    bodyDraft: '',
    suggestedType: 'skill',
    score: 0,
    sourceRefs: Array.from({ length: refCount }, (_, i) => ({
      source: 'claude' as const,
      conversationId: `${name}-conv-${i}`,
      excerpt: '',
      at: refDate,
    })),
    model: 'test',
    sourceClusterId: opts.clusterId,
  }
}

function commandCand(
  name: string,
  opts: { invocations?: number; promptLen?: number; refDate?: string } = {},
): Gen {
  const refDate = opts.refDate ?? '2026-05-20T00:00:00.000Z'
  return {
    signature: `command::${name}`,
    name,
    description: name,
    bodyDraft: '',
    suggestedType: 'command',
    score: 0,
    sourceRefs: [{ source: 'claude', conversationId: 'x', excerpt: '', at: refDate }],
    model: 'test',
    promptText: 'p'.repeat(opts.promptLen ?? 200),
    invocationCount: opts.invocations ?? 2,
  }
}

function subagentCand(
  name: string,
  opts: { constituents?: string[]; refCount?: number } = {},
): Gen {
  const refCount = opts.refCount ?? 3
  return {
    signature: `subagent::${name}`,
    name,
    description: name,
    bodyDraft: '',
    suggestedType: 'subagent',
    score: 0,
    sourceRefs: Array.from({ length: refCount }, (_, i) => ({
      source: 'claude' as const,
      conversationId: `${name}-${i}`,
      excerpt: '',
      at: '2026-05-22T00:00:00.000Z',
    })),
    model: 'test',
    constituentSkills: opts.constituents ?? ['a', 'b'],
  }
}

function ruleCand(
  name: string,
  opts: { refCount?: number; ruleText?: string } = {},
): Gen {
  const refCount = opts.refCount ?? 5
  return {
    signature: `rule::${name}`,
    name,
    description: name,
    bodyDraft: '',
    suggestedType: 'rule',
    score: 0,
    sourceRefs: Array.from({ length: refCount }, (_, i) => ({
      source: 'claude' as const,
      conversationId: `${name}-${i}`,
      excerpt: '',
      at: '2026-05-22T00:00:00.000Z',
    })),
    model: 'test',
    ruleText: opts.ruleText ?? 'Always use TypeScript for new server files',
  }
}

function cluster(
  id: string,
  opts: { members?: string[]; recurrence?: number; recency?: number; succ?: number; total?: number } = {},
): IntentCluster {
  return {
    clusterId: id,
    members: opts.members ?? [],
    centroidIntent: '',
    centroidSlotValues: {},
    recurrenceCount: opts.recurrence ?? 3,
    dateSpan: { start: '', end: '' },
    medianGapDays: 0,
    recencyDays: opts.recency ?? 0,
    commonToolSignature: [],
    convergentApproach: [],
    outcomeBreakdown: {
      succeeded: opts.succ ?? (opts.total ?? 3),
      failed: (opts.total ?? 3) - (opts.succ ?? (opts.total ?? 3)),
      abandoned: 0,
      partial: 0,
    },
  }
}

function summary(arcId: string, personalizationCount: number): ConversationSummary {
  return {
    arcId,
    conversationId: 'c',
    source: 'claude',
    startedAt: '2026-05-20T00:00:00.000Z',
    intent: '',
    slotValues: { files: [], tools: [], libraries: [], mcps: [] },
    resolutionSteps: [],
    outcome: 'succeeded',
    stableApproach: true,
    subGoals: [],
    toolSignature: [],
    invokedSkills: [],
    verbatimUserPrompts: [],
    correctionMarkers: [],
    personalizationSignals: Array.from({ length: personalizationCount }, () => ({
      kind: 'style', evidence: 'x',
    })),
  }
}

// ---- helpers ----------------------------------------------------------------

describe('rank helpers', () => {
  it('recencyDecay drops with days', () => {
    expect(rankTest.recencyDecay(0)).toBe(1)
    expect(rankTest.recencyDecay(30)).toBeCloseTo(0.5, 2)
    expect(rankTest.recencyDecay(90)).toBeCloseTo(0.25, 2)
  })

  it('specificityScore floors at 0.5 and grows with length+richness', () => {
    const short = rankTest.specificityScore('use prettier')
    const long = rankTest.specificityScore('Always use prettier on staged TypeScript files before committing to enforce consistent formatting across the project.')
    expect(short).toBeGreaterThanOrEqual(0.5)
    expect(long).toBeGreaterThan(short)
  })

  it('recencyDaysFromRefs returns 0 when refs have no parseable dates', () => {
    const c = skillCand('x')
    c.sourceRefs = [{ source: 'claude', conversationId: 'x', excerpt: '', at: 'not-a-date' }]
    expect(rankTest.recencyDaysFromRefs(c, NOW)).toBe(0)
  })
})

// ---- per-kind scoring -------------------------------------------------------

describe('per-kind scoring', () => {
  it('recent + frequent skill beats old + frequent skill', () => {
    const recent = skillCand('recent', { clusterId: 'c-recent' })
    const old    = skillCand('old',    { clusterId: 'c-old'    })
    const clusters = new Map<string, IntentCluster>([
      ['c-recent', cluster('c-recent', { recurrence: 10, recency: 1, succ: 9, total: 10 })],
      ['c-old',    cluster('c-old',    { recurrence: 10, recency: 60, succ: 9, total: 10 })],
    ])
    const out = rankCandidates([recent, old], { clustersById: clusters })
    expect(out[0].name).toBe('recent')
    expect(out[0].score).toBeGreaterThan(out[1].score)
  })

  it('personalizationSignal count boosts skill score', () => {
    const high = skillCand('high', { clusterId: 'c-high' })
    const low  = skillCand('low',  { clusterId: 'c-low' })
    const clusters = new Map<string, IntentCluster>([
      ['c-high', cluster('c-high', { recurrence: 3, members: ['a1', 'a2', 'a3'] })],
      ['c-low',  cluster('c-low',  { recurrence: 3, members: ['b1', 'b2', 'b3'] })],
    ])
    const summaries = new Map<string, ConversationSummary>([
      ['a1', summary('a1', 5)], ['a2', summary('a2', 5)], ['a3', summary('a3', 5)],
      ['b1', summary('b1', 0)], ['b2', summary('b2', 0)], ['b3', summary('b3', 0)],
    ])
    const out = rankCandidates([low, high], { clustersById: clusters, summariesByArc: summaries })
    expect(out[0].name).toBe('high')
  })

  it('command score scales with invocation count and prompt length', () => {
    const small = commandCand('small', { invocations: 2, promptLen: 100, refDate: '2026-05-22T00:00:00.000Z' })
    const big   = commandCand('big',   { invocations: 5, promptLen: 800, refDate: '2026-05-22T00:00:00.000Z' })
    const out = rankCandidates([small, big], { nowMs: NOW })
    expect(out[0].name).toBe('big')
  })

  it('subagent score boosts when constituent skills are in existingSkillNames', () => {
    const familiar  = subagentCand('familiar',  { constituents: ['a', 'b'] })
    const novel     = subagentCand('novel',     { constituents: ['x', 'y'] })
    const out = rankCandidates([novel, familiar], {
      existingSkillNames: new Set(['a', 'b']),
    })
    expect(out[0].name).toBe('familiar')
  })

  it('rule score scales with breadth + specificity', () => {
    const broad   = ruleCand('broad',   { refCount: 10, ruleText: 'Always use prettier on staged TypeScript files before commit to keep formatting consistent.' })
    const narrow  = ruleCand('narrow',  { refCount: 5,  ruleText: 'use prettier' })
    const out = rankCandidates([narrow, broad])
    expect(out[0].name).toBe('broad')
  })
})

// ---- topK truncation --------------------------------------------------------

describe('rankCandidates topK', () => {
  it('returns top-K per kind sorted by score', () => {
    const candidates: Gen[] = []
    for (let i = 0; i < 20; i++) {
      candidates.push(skillCand(`skill-${i}`, {
        clusterId: `c-${i}`,
      }))
    }
    const clusters = new Map<string, IntentCluster>()
    for (let i = 0; i < 20; i++) {
      clusters.set(`c-${i}`, cluster(`c-${i}`, { recurrence: i + 1, recency: 0, succ: i + 1, total: i + 1 }))
    }
    const out = rankCandidates(candidates, { clustersById: clusters, topK: 10 })
    expect(out).toHaveLength(10)
    // Largest recurrence → highest score → comes first.
    expect(out[0].name).toBe('skill-19')
    expect(out[9].name).toBe('skill-10')
  })

  it('truncation is per-kind, not global', () => {
    const cs: Gen[] = []
    for (let i = 0; i < 12; i++) cs.push(skillCand(`s-${i}`))
    for (let i = 0; i < 12; i++) cs.push(commandCand(`c-${i}`))
    const out = rankCandidates(cs, { topK: 5 })
    const skills = out.filter(c => c.suggestedType === 'skill')
    const commands = out.filter(c => c.suggestedType === 'command')
    expect(skills.length).toBe(5)
    expect(commands.length).toBe(5)
  })

  it('is deterministic for fixed inputs', () => {
    const cs = Array.from({ length: 5 }, (_, i) => skillCand(`s-${i}`))
    const r1 = rankCandidates(cs, { nowMs: NOW })
    const r2 = rankCandidates(cs, { nowMs: NOW })
    expect(r1.map(c => c.name)).toEqual(r2.map(c => c.name))
    expect(r1.map(c => c.score)).toEqual(r2.map(c => c.score))
  })
})

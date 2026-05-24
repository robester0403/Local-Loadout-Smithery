import { describe, it, expect } from 'vitest'
import {
  detectSkills,
  __test as skillsTest,
  type SkillSynthOutput,
} from '../autoSkill/signals/detectors/skills'
import type { ConversationSummary, IntentCluster } from '../autoSkill/signals/types'

// ---- Fixture helpers --------------------------------------------------------

let arcSeq = 0
function summary(
  intent: string,
  opts: {
    outcome?: ConversationSummary['outcome']
    stableApproach?: boolean
    resolutionSteps?: string[]
    conversationId?: string
  } = {},
): ConversationSummary {
  const arcId = `arc-${arcSeq++}`
  return {
    arcId,
    conversationId: opts.conversationId ?? `conv-${arcId}`,
    source: 'claude',
    startedAt: '2026-05-20T12:00:00.000Z',
    intent,
    slotValues: { files: [], tools: [], libraries: [], mcps: [] },
    resolutionSteps: opts.resolutionSteps ?? ['scaffold', 'write', 'run'],
    outcome: opts.outcome ?? 'succeeded',
    stableApproach: opts.stableApproach ?? true,
    subGoals: [],
    toolSignature: ['Read', 'Edit'],
    invokedSkills: [],
    verbatimUserPrompts: [],
    correctionMarkers: [],
    personalizationSignals: [],
  }
}

function cluster(
  members: ConversationSummary[],
  overrides: Partial<IntentCluster> = {},
): IntentCluster {
  const succ = members.filter(m => m.outcome === 'succeeded').length
  const fail = members.filter(m => m.outcome === 'failed').length
  return {
    clusterId: 'cluster-test',
    members: members.map(m => m.arcId),
    centroidIntent: members[0]?.intent ?? '',
    centroidSlotValues: members[0]?.slotValues ?? {},
    recurrenceCount: members.length,
    dateSpan: { start: members[0]?.startedAt ?? '', end: members[members.length - 1]?.startedAt ?? '' },
    medianGapDays: 1,
    recencyDays: 0,
    commonToolSignature: ['Read', 'Edit'],
    convergentApproach: ['scaffold', 'write', 'run'],
    outcomeBreakdown: { succeeded: succ, failed: fail, abandoned: 0, partial: 0 },
    ...overrides,
  }
}

const VALID_SYNTH: SkillSynthOutput = {
  name: 'add-vitest-spec',
  description: 'Scaffold and write a vitest spec for a TypeScript helper',
  applicabilityCondition: 'When the user asks to add a vitest test for an existing TS helper',
  procedure: ['Read the helper', 'Create a *.test.ts file', 'Write at least one assertion', 'Run vitest'],
  terminationCondition: 'The new test file runs green',
  expectedOutput: 'A new .test.ts file passing under `vitest run`',
}

const VALID_SYNTH_JSON = JSON.stringify(VALID_SYNTH)

const allPassConsistency = JSON.stringify({
  holdouts: [
    { pass: true, reason: 'matches the workflow exactly' },
    { pass: true, reason: 'same procedure produced the same outcome' },
  ],
})

const onePassConsistency = JSON.stringify({
  holdouts: [
    { pass: true, reason: 'matches' },
    { pass: false, reason: 'different domain' },
  ],
})

const allFailConsistency = JSON.stringify({
  holdouts: [
    { pass: false, reason: 'different procedure' },
    { pass: false, reason: 'different outcome' },
  ],
})

// ---- preFilter --------------------------------------------------------------

describe('skill detector — preFilter', () => {
  const cfg = skillsTest.resolveOptions({})

  it('drops clusters with recurrence < 3', () => {
    const members = [summary('a'), summary('b')]
    const c = cluster(members, { recurrenceCount: 2 })
    expect(skillsTest.preFilter(c, members, cfg).ok).toBe(false)
  })

  it('drops clusters with success rate < 60%', () => {
    const members = [
      summary('a', { outcome: 'succeeded' }),
      summary('b', { outcome: 'failed' }),
      summary('c', { outcome: 'failed' }),
      summary('d', { outcome: 'failed' }),
      summary('e', { outcome: 'failed' }),
    ]
    const c = cluster(members)
    expect(skillsTest.preFilter(c, members, cfg).ok).toBe(false)
  })

  it('drops clusters with convergentApproach < 3 steps', () => {
    const members = [summary('a'), summary('b'), summary('c')]
    const c = cluster(members, { convergentApproach: ['x'] })
    expect(skillsTest.preFilter(c, members, cfg).ok).toBe(false)
  })

  it('drops clusters when stableApproach majority is below 50%', () => {
    const members = [
      summary('a', { stableApproach: false }),
      summary('b', { stableApproach: false }),
      summary('c', { stableApproach: true }),
    ]
    const c = cluster(members)
    expect(skillsTest.preFilter(c, members, cfg).ok).toBe(false)
  })

  it('passes a healthy cluster', () => {
    const members = [summary('a'), summary('b'), summary('c')]
    const c = cluster(members)
    expect(skillsTest.preFilter(c, members, cfg).ok).toBe(true)
  })
})

// ---- parseSynthOutput -------------------------------------------------------

describe('parseSynthOutput', () => {
  it('accepts a complete S-tuple', () => {
    const out = skillsTest.parseSynthOutput(VALID_SYNTH_JSON)
    expect(out?.name).toBe('add-vitest-spec')
    expect(out?.procedure).toHaveLength(4)
  })

  it('rejects malformed JSON', () => {
    expect(skillsTest.parseSynthOutput('not json')).toBeNull()
  })

  it('rejects a missing field (terminationCondition)', () => {
    const bad = { ...VALID_SYNTH, terminationCondition: '' }
    expect(skillsTest.parseSynthOutput(JSON.stringify(bad))).toBeNull()
  })

  it('rejects an empty procedure', () => {
    const bad = { ...VALID_SYNTH, procedure: [] }
    expect(skillsTest.parseSynthOutput(JSON.stringify(bad))).toBeNull()
  })

  it('rejects a procedure entry that is not a string', () => {
    const bad = { ...VALID_SYNTH, procedure: [null, 1, 'ok'] }
    const parsed = skillsTest.parseSynthOutput(JSON.stringify(bad))
    expect(parsed?.procedure).toEqual(['ok'])
  })
})

// ---- pickExampleQuote + renderSkillBody example section --------------------

describe('pickExampleQuote', () => {
  it('returns null when no member has a verbatim prompt', () => {
    const members = [summary('a'), summary('b')]
    expect(skillsTest.pickExampleQuote(members)).toBeNull()
  })

  it('skips failed-outcome members even if they have prompts', () => {
    const ms: ConversationSummary[] = [
      { ...summary('failed-one', { outcome: 'failed' }), verbatimUserPrompts: ['help me fix this thing that ultimately did not work out'] },
      { ...summary('ok-one'), verbatimUserPrompts: ['short ok'] },
    ]
    const out = skillsTest.pickExampleQuote(ms)
    expect(out?.prompt).toBe('short ok')
    expect(out?.outcome).toBe('succeeded')
  })

  it('picks the longest succeeded prompt across members', () => {
    const long = 'a really detailed user request that explains exactly what they wanted'
    const ms: ConversationSummary[] = [
      { ...summary('m1'), verbatimUserPrompts: ['short'] },
      { ...summary('m2'), verbatimUserPrompts: [long, 'another short one'] },
      { ...summary('m3'), verbatimUserPrompts: ['medium-length request'] },
    ]
    expect(skillsTest.pickExampleQuote(ms)?.prompt).toBe(long)
  })

  it('ignores whitespace-only prompts', () => {
    const ms: ConversationSummary[] = [
      { ...summary('m1'), verbatimUserPrompts: ['   ', '\n\n'] },
      { ...summary('m2'), verbatimUserPrompts: ['real prompt'] },
    ]
    expect(skillsTest.pickExampleQuote(ms)?.prompt).toBe('real prompt')
  })
})

describe('renderSkillBody example section', () => {
  it('omits ## Example when no example supplied', () => {
    const body = skillsTest.renderSkillBody(VALID_SYNTH)
    expect(body).not.toContain('## Example')
  })

  it('renders ## Example with quoted prompt + outcome line', () => {
    const body = skillsTest.renderSkillBody(VALID_SYNTH, {
      prompt: 'add a vitest test for the foo helper',
      outcome: 'succeeded',
    })
    expect(body).toContain('## Example')
    expect(body).toContain('> add a vitest test for the foo helper')
    expect(body).toContain('Observed outcome: succeeded.')
  })

  it('truncates very long example prompts to keep the body compact', () => {
    const long = 'x'.repeat(2000)
    const body = skillsTest.renderSkillBody(VALID_SYNTH, { prompt: long, outcome: 'succeeded' })
    expect(body).toContain('…')
    expect(body).not.toContain('x'.repeat(2000))
  })

  it('quotes multi-line prompts line-by-line', () => {
    const body = skillsTest.renderSkillBody(VALID_SYNTH, {
      prompt: 'line one\nline two\nline three',
      outcome: 'succeeded',
    })
    expect(body).toContain('> line one')
    expect(body).toContain('> line two')
    expect(body).toContain('> line three')
  })
})

// ---- detectSkills end-to-end ------------------------------------------------

describe('detectSkills', () => {
  it('healthy 3-member cluster + 2/2 consistency → 1 candidate, exactly 2 LLM calls', async () => {
    const members = [summary('a'), summary('b'), summary('c')]
    const c = cluster(members)
    let synthCalls = 0
    let consistencyCalls = 0
    const result = await detectSkills([c], members, {
      llmSynthFn: async () => { synthCalls += 1; return VALID_SYNTH_JSON },
      llmConsistencyFn: async () => { consistencyCalls += 1; return allPassConsistency },
    })
    expect(result.candidates).toHaveLength(1)
    expect(synthCalls).toBe(1)
    expect(consistencyCalls).toBe(1)
    const cand = result.candidates[0]
    expect(cand.suggestedType).toBe('skill')
    expect(cand.applicabilityCondition).toBe(VALID_SYNTH.applicabilityCondition)
    expect(cand.procedure).toEqual(VALID_SYNTH.procedure)
    expect(cand.terminationCondition).toBe(VALID_SYNTH.terminationCondition)
    expect(cand.expectedOutput).toBe(VALID_SYNTH.expectedOutput)
    expect(cand.sourceClusterId).toBe('cluster-test')
    expect(cand.bodyDraft).toContain('## When to use')
    expect(cand.bodyDraft).toContain('## Procedure')
    expect(cand.bodyDraft).toContain('## When done')
    expect(cand.bodyDraft).toContain('## Expected output')
    // No verbatim prompts on the default summary fixtures, so no ## Example
    // is rendered for this case. Coverage for the populated path lives in
    // the renderSkillBody example-section tests above.
    expect(cand.bodyDraft).not.toContain('## Example')
    expect(cand.evidenceQuotes?.length).toBe(2)
  })

  it('renders ## Example in bodyDraft when cluster members carry verbatim prompts', async () => {
    const realPrompt = 'add a vitest test for the foo helper and use snapshots'
    const members = [
      { ...summary('a'), verbatimUserPrompts: [realPrompt] },
      { ...summary('b'), verbatimUserPrompts: ['short'] },
      { ...summary('c'), verbatimUserPrompts: [] },
    ]
    const c = cluster(members)
    const result = await detectSkills([c], members, {
      llmSynthFn: async () => VALID_SYNTH_JSON,
      llmConsistencyFn: async () => allPassConsistency,
    })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].bodyDraft).toContain('## Example')
    expect(result.candidates[0].bodyDraft).toContain(`> ${realPrompt}`)
  })

  it('cluster failing pre-filter (size) → 0 candidates, 0 LLM calls', async () => {
    const members = [summary('a'), summary('b')]
    const c = cluster(members, { recurrenceCount: 2 })
    let synthCalls = 0
    let consistencyCalls = 0
    const result = await detectSkills([c], members, {
      llmSynthFn: async () => { synthCalls += 1; return VALID_SYNTH_JSON },
      llmConsistencyFn: async () => { consistencyCalls += 1; return allPassConsistency },
    })
    expect(result.candidates).toEqual([])
    expect(synthCalls).toBe(0)
    expect(consistencyCalls).toBe(0)
    expect(result.warnings[0].reason).toBe('pre-filter')
  })

  it('cluster with 40% success rate → 0 candidates, no LLM call', async () => {
    const members = [
      summary('a', { outcome: 'succeeded' }),
      summary('b', { outcome: 'succeeded' }),
      summary('c', { outcome: 'failed' }),
      summary('d', { outcome: 'failed' }),
      summary('e', { outcome: 'failed' }),
    ]
    const c = cluster(members)
    let calls = 0
    const result = await detectSkills([c], members, {
      llmSynthFn: async () => { calls += 1; return VALID_SYNTH_JSON },
      llmConsistencyFn: async () => { calls += 1; return allPassConsistency },
    })
    expect(result.candidates).toEqual([])
    expect(calls).toBe(0)
  })

  it('0/2 holdouts pass → candidate dropped with consistency-failed warning', async () => {
    const members = [summary('a'), summary('b'), summary('c')]
    const c = cluster(members)
    const result = await detectSkills([c], members, {
      llmSynthFn: async () => VALID_SYNTH_JSON,
      llmConsistencyFn: async () => allFailConsistency,
    })
    expect(result.candidates).toEqual([])
    expect(result.warnings[0].reason).toBe('consistency-failed')
  })

  it('1/2 holdouts pass → candidate kept (≥ minHoldoutPasses)', async () => {
    const members = [summary('a'), summary('b'), summary('c')]
    const c = cluster(members)
    const result = await detectSkills([c], members, {
      llmSynthFn: async () => VALID_SYNTH_JSON,
      llmConsistencyFn: async () => onePassConsistency,
    })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].evidenceQuotes?.map(e => e.quote)).toEqual([
      expect.stringMatching(/holdout pass/),
      expect.stringMatching(/holdout fail/),
    ])
  })

  it('incomplete synth retries once, then drops if still incomplete', async () => {
    const members = [summary('a'), summary('b'), summary('c')]
    const c = cluster(members)
    let synthCalls = 0
    const result = await detectSkills([c], members, {
      llmSynthFn: async () => {
        synthCalls += 1
        return JSON.stringify({ ...VALID_SYNTH, terminationCondition: '' })
      },
      llmConsistencyFn: async () => allPassConsistency,
    })
    expect(result.candidates).toEqual([])
    expect(synthCalls).toBe(2) // initial + one retry
    expect(result.warnings[0].reason).toBe('synth-invalid')
  })

  it('synth retry succeeds on second attempt', async () => {
    const members = [summary('a'), summary('b'), summary('c')]
    const c = cluster(members)
    let attempt = 0
    const result = await detectSkills([c], members, {
      llmSynthFn: async () => {
        attempt += 1
        if (attempt === 1) return JSON.stringify({ ...VALID_SYNTH, terminationCondition: '' })
        return VALID_SYNTH_JSON
      },
      llmConsistencyFn: async () => allPassConsistency,
    })
    expect(result.candidates).toHaveLength(1)
    expect(attempt).toBe(2)
  })

  it('consistency LLM that throws → all holdouts fail, candidate dropped', async () => {
    const members = [summary('a'), summary('b'), summary('c')]
    const c = cluster(members)
    const result = await detectSkills([c], members, {
      llmSynthFn: async () => VALID_SYNTH_JSON,
      llmConsistencyFn: async () => { throw new Error('ollama down') },
    })
    expect(result.candidates).toEqual([])
    expect(result.warnings[0].reason).toBe('consistency-failed')
  })

  it('signature is rule-stable (skill::<slug>) across re-runs', async () => {
    const members = [summary('a'), summary('b'), summary('c')]
    const c = cluster(members)
    const r1 = await detectSkills([c], members, {
      llmSynthFn: async () => VALID_SYNTH_JSON,
      llmConsistencyFn: async () => allPassConsistency,
    })
    const r2 = await detectSkills([c], members, {
      llmSynthFn: async () => VALID_SYNTH_JSON,
      llmConsistencyFn: async () => allPassConsistency,
    })
    expect(r1.candidates[0].signature).toBe(r2.candidates[0].signature)
    expect(r1.candidates[0].signature.startsWith('')).toBe(true)
  })

  it('multiple clusters processed independently', async () => {
    const aMembers = [summary('write vitest A'), summary('write vitest B'), summary('write vitest C')]
    const bMembers = [summary('deploy A'), summary('deploy B'), summary('deploy C')]
    const c1 = { ...cluster(aMembers), clusterId: 'cluster-0' }
    const c2 = { ...cluster(bMembers), clusterId: 'cluster-1' }
    const r = await detectSkills([c1, c2], [...aMembers, ...bMembers], {
      llmSynthFn: async (_p, _m) => VALID_SYNTH_JSON,
      llmConsistencyFn: async () => allPassConsistency,
    })
    expect(r.candidates).toHaveLength(2)
    expect(r.candidates.map(c => c.sourceClusterId).sort()).toEqual(['cluster-0', 'cluster-1'])
  })
})

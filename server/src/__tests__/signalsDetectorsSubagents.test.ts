import { describe, it, expect } from 'vitest'
import {
  detectSubagents,
  __test as subTest,
  type SubagentSynthOutput,
} from '../autoSkill/signals/detectors/subagents'
import type { ConversationSummary } from '../autoSkill/signals/types'

// ---- Fixture helpers --------------------------------------------------------

let seq = 0
function summary(
  conversationId: string,
  intent: string,
  opts: {
    invokedSkills?: string[]
    outcome?: ConversationSummary['outcome']
    offsetMin?: number
  } = {},
): ConversationSummary {
  const arcId = `arc-${conversationId}-${seq++}`
  return {
    arcId,
    conversationId,
    source: 'claude',
    startedAt: new Date(Date.UTC(2026, 4, 23, 12, opts.offsetMin ?? 0, 0)).toISOString(),
    intent,
    slotValues: { files: [], tools: [], libraries: [], mcps: [] },
    resolutionSteps: [],
    outcome: opts.outcome ?? 'succeeded',
    stableApproach: true,
    subGoals: [],
    toolSignature: [],
    invokedSkills: opts.invokedSkills ?? [],
    verbatimUserPrompts: [],
    correctionMarkers: [],
    personalizationSignals: [],
  }
}

const VALID_SYNTH: SubagentSynthOutput = {
  name: 'pr-review-and-test',
  description: 'Review a PR, then run the test suite, then summarize',
  constituentSkills: ['pr-review', 'run-tests'],
  orchestrationPattern: ['Read PR diff', 'Run tests', 'Summarize'],
  inputShape: 'A PR url or number',
  outputShape: 'A summary including test results and review comments',
}
const VALID_SYNTH_JSON = JSON.stringify(VALID_SYNTH)

// ---- Pattern mining primitives ---------------------------------------------

describe('containsSubsequence', () => {
  it('finds contiguous subsequences', () => {
    expect(subTest.containsSubsequence(['a', 'b', 'c', 'd'], ['b', 'c'])).toBe(true)
    expect(subTest.containsSubsequence(['a', 'b', 'c', 'd'], ['b', 'd'])).toBe(false)
    expect(subTest.containsSubsequence(['a', 'b'], ['a', 'b', 'c'])).toBe(false)
  })
})

describe('subsumptionDedup', () => {
  it('drops a short pattern subsumed by a longer one with the same conv set', () => {
    const short = {
      key: 'a||b',
      tags: ['a', 'b'],
      instances: [
        { conversationId: 'c1', startArcId: 'x', endArcId: 'y', endOutcome: 'succeeded' as const },
        { conversationId: 'c2', startArcId: 'x', endArcId: 'y', endOutcome: 'succeeded' as const },
        { conversationId: 'c3', startArcId: 'x', endArcId: 'y', endOutcome: 'succeeded' as const },
      ],
    }
    const long = {
      key: 'a||b||c',
      tags: ['a', 'b', 'c'],
      instances: [
        { conversationId: 'c1', startArcId: 'x', endArcId: 'z', endOutcome: 'succeeded' as const },
        { conversationId: 'c2', startArcId: 'x', endArcId: 'z', endOutcome: 'succeeded' as const },
        { conversationId: 'c3', startArcId: 'x', endArcId: 'z', endOutcome: 'succeeded' as const },
      ],
    }
    const out = subTest.subsumptionDedup([short, long])
    expect(out.map(o => o.key)).toEqual(['a||b||c'])
  })

  it('keeps both when the short pattern appears in additional conversations', () => {
    const short = {
      key: 'a||b',
      tags: ['a', 'b'],
      instances: [
        { conversationId: 'c1', startArcId: 'x', endArcId: 'y', endOutcome: 'succeeded' as const },
        { conversationId: 'c2', startArcId: 'x', endArcId: 'y', endOutcome: 'succeeded' as const },
        { conversationId: 'c3', startArcId: 'x', endArcId: 'y', endOutcome: 'succeeded' as const },
        { conversationId: 'c4', startArcId: 'x', endArcId: 'y', endOutcome: 'succeeded' as const }, // extra
      ],
    }
    const long = {
      key: 'a||b||c',
      tags: ['a', 'b', 'c'],
      instances: [
        { conversationId: 'c1', startArcId: 'x', endArcId: 'z', endOutcome: 'succeeded' as const },
        { conversationId: 'c2', startArcId: 'x', endArcId: 'z', endOutcome: 'succeeded' as const },
        { conversationId: 'c3', startArcId: 'x', endArcId: 'z', endOutcome: 'succeeded' as const },
      ],
    }
    const out = subTest.subsumptionDedup([short, long])
    expect(out.map(o => o.key).sort()).toEqual(['a||b', 'a||b||c'])
  })
})

// ---- parseSynthOutput -------------------------------------------------------

describe('parseSynthOutput', () => {
  const pattern = { key: 'pr-review||run-tests', tags: ['pr-review', 'run-tests'], instances: [] }

  it('accepts a complete payload', () => {
    const out = subTest.parseSynthOutput(VALID_SYNTH_JSON, pattern)
    expect(out?.name).toBe('pr-review-and-test')
    expect(out?.constituentSkills).toEqual(['pr-review', 'run-tests'])
  })

  it('falls back to pattern tags when constituentSkills is missing', () => {
    const bad = { ...VALID_SYNTH }
    delete (bad as Partial<SubagentSynthOutput>).constituentSkills
    const out = subTest.parseSynthOutput(JSON.stringify(bad), pattern)
    expect(out?.constituentSkills).toEqual(['pr-review', 'run-tests'])
  })

  it('rejects missing inputShape', () => {
    const bad = { ...VALID_SYNTH, inputShape: '' }
    expect(subTest.parseSynthOutput(JSON.stringify(bad), pattern)).toBeNull()
  })

  it('rejects empty orchestrationPattern', () => {
    const bad = { ...VALID_SYNTH, orchestrationPattern: [] }
    expect(subTest.parseSynthOutput(JSON.stringify(bad), pattern)).toBeNull()
  })

  it('rejects malformed JSON', () => {
    expect(subTest.parseSynthOutput('not json', pattern)).toBeNull()
  })
})

// ---- detectSubagents end-to-end --------------------------------------------

describe('detectSubagents', () => {
  function threeConversationsWith(pattern: string[], outcomes: Array<ConversationSummary['outcome']> = ['succeeded', 'succeeded', 'succeeded']): {
    summaries: ConversationSummary[]
    skillTags: Map<string, string | null>
  } {
    const summaries: ConversationSummary[] = []
    const skillTags = new Map<string, string | null>()
    for (let c = 0; c < 3; c++) {
      const conv = `conv-${c}`
      for (let i = 0; i < pattern.length; i++) {
        const s = summary(conv, `step ${i}`, {
          offsetMin: i,
          outcome: i === pattern.length - 1 ? outcomes[c] ?? 'succeeded' : 'succeeded',
        })
        summaries.push(s)
        skillTags.set(s.arcId, pattern[i] === '__custom' ? null : pattern[i])
      }
    }
    return { summaries, skillTags }
  }

  it('3 conversations each running [skillA → skillB] → 1 candidate, 1 LLM call', async () => {
    const { summaries, skillTags } = threeConversationsWith(['skillA', 'skillB'])
    let synthCalls = 0
    const result = await detectSubagents(summaries, [], {
      skillTags,
      llmSynthFn: async () => { synthCalls += 1; return VALID_SYNTH_JSON },
    })
    expect(result.candidates).toHaveLength(1)
    expect(synthCalls).toBe(1)
    const cand = result.candidates[0]
    expect(cand.suggestedType).toBe('subagent')
    expect(cand.constituentSkills).toEqual(['pr-review', 'run-tests'])
    expect(cand.orchestrationPattern).toEqual(VALID_SYNTH.orchestrationPattern)
    expect(cand.inputShape).toBe(VALID_SYNTH.inputShape)
    expect(cand.outputShape).toBe(VALID_SYNTH.outputShape)
    expect(cand.sourceClusterId).toBe('subagent-pattern::skillA||skillB')
    expect(cand.bodyDraft).toContain('## Constituent skills')
  })

  it('2 conversations with the pattern → 0 candidates (below threshold)', async () => {
    const summaries: ConversationSummary[] = []
    const skillTags = new Map<string, string | null>()
    for (let c = 0; c < 2; c++) {
      const conv = `conv-${c}`
      const s1 = summary(conv, 'step a', { offsetMin: 0 })
      const s2 = summary(conv, 'step b', { offsetMin: 1 })
      summaries.push(s1, s2)
      skillTags.set(s1.arcId, 'skillA')
      skillTags.set(s2.arcId, 'skillB')
    }
    const result = await detectSubagents(summaries, [], {
      skillTags,
      llmSynthFn: async () => VALID_SYNTH_JSON,
    })
    expect(result.candidates).toEqual([])
  })

  it('pattern with no bounded shape (last arc fails in majority) → dropped', async () => {
    const { summaries, skillTags } = threeConversationsWith(
      ['skillA', 'skillB'],
      ['failed', 'failed', 'succeeded'],
    )
    const result = await detectSubagents(summaries, [], {
      skillTags,
      llmSynthFn: async () => VALID_SYNTH_JSON,
    })
    expect(result.candidates).toEqual([])
    expect(result.warnings.some(w => w.reason === 'unbounded-shape')).toBe(true)
  })

  it('all-custom window is not surfaced as a pattern', async () => {
    const { summaries, skillTags } = threeConversationsWith(['__custom', '__custom'])
    const result = await detectSubagents(summaries, [], {
      skillTags,
      llmSynthFn: async () => VALID_SYNTH_JSON,
    })
    expect(result.candidates).toEqual([])
  })

  it('repeated single-skill pattern [skillA, skillA] is not orchestration', async () => {
    const { summaries, skillTags } = threeConversationsWith(['skillA', 'skillA'])
    const result = await detectSubagents(summaries, [], {
      skillTags,
      llmSynthFn: async () => VALID_SYNTH_JSON,
    })
    expect(result.candidates).toEqual([])
  })

  it('synth-invalid logged as warning, candidate dropped', async () => {
    const { summaries, skillTags } = threeConversationsWith(['skillA', 'skillB'])
    const result = await detectSubagents(summaries, [], {
      skillTags,
      llmSynthFn: async () => JSON.stringify({ ...VALID_SYNTH, inputShape: '' }),
    })
    expect(result.candidates).toEqual([])
    expect(result.warnings.some(w => w.reason === 'synth-invalid')).toBe(true)
  })

  it('cross-references newly-proposed skills (skillTags includes a "new-" prefix)', async () => {
    const { summaries, skillTags } = threeConversationsWith(['new-skill', 'skillB'])
    const result = await detectSubagents(summaries, [], {
      skillTags,
      llmSynthFn: async () => JSON.stringify({
        ...VALID_SYNTH,
        constituentSkills: ['new-skill', 'skillB'],
      }),
    })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].constituentSkills).toEqual(['new-skill', 'skillB'])
  })

  it('longer subsuming pattern wins over its short prefix', async () => {
    // 3 conversations each running [A, B, C]; both [A, B] and [A, B, C]
    // would qualify, but the longer wins via subsumption.
    const { summaries, skillTags } = threeConversationsWith(['skillA', 'skillB', 'skillC'])
    const result = await detectSubagents(summaries, [], {
      skillTags,
      llmSynthFn: async () => VALID_SYNTH_JSON,
    })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].sourceClusterId).toBe('subagent-pattern::skillA||skillB||skillC')
  })

  it('uses Phase-1 invokedSkills when no embedFn supplied and no skillTags override', async () => {
    // No embedFn, no skillTags → fall back to invokedSkills name match.
    const skills = [
      { name: 'pr-review', description: '' },
      { name: 'run-tests', description: '' },
    ]
    const summaries: ConversationSummary[] = []
    for (let c = 0; c < 3; c++) {
      const conv = `conv-${c}`
      summaries.push(summary(conv, 'review', { offsetMin: 0, invokedSkills: ['pr-review'] }))
      summaries.push(summary(conv, 'test',   { offsetMin: 1, invokedSkills: ['run-tests'] }))
    }
    const result = await detectSubagents(summaries, skills, {
      llmSynthFn: async () => VALID_SYNTH_JSON,
    })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].constituentSkills).toEqual(['pr-review', 'run-tests'])
  })

  it('signature is stable across re-runs', async () => {
    const { summaries, skillTags } = threeConversationsWith(['skillA', 'skillB'])
    const r1 = await detectSubagents(summaries, [], {
      skillTags,
      llmSynthFn: async () => VALID_SYNTH_JSON,
    })
    const r2 = await detectSubagents(summaries, [], {
      skillTags,
      llmSynthFn: async () => VALID_SYNTH_JSON,
    })
    expect(r1.candidates[0].signature).toBe(r2.candidates[0].signature)
  })
})

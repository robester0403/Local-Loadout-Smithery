import { describe, it, expect } from 'vitest'
import { detectRules } from '../autoSkill/signals/detectors/rules'
import { __test as rulesTest } from '../autoSkill/signals/detectors/rules'
import {
  computeRuleMarkerId,
  ruleMarkerStart,
  ruleMarkerEnd,
  extractRuleMarkerIds,
} from '../autoSkill/signals/lib/ruleMarkers'
import type { ConversationSummary, IntentCluster } from '../autoSkill/signals/types'
import type { ExistingRuleFile } from '../autoSkill/signals/lib/ruleMarkers'

// ---- Fixture helpers --------------------------------------------------------

let nextArc = 0
function summary(opts: {
  conversationId: string
  personalizationSignals?: Array<{ kind: string; evidence: string }>
  correctionMarkers?: Array<{ quote: string; kind: 'frustration' | 'reversal' }>
}): ConversationSummary {
  const arc = `arc-${nextArc++}`
  return {
    arcId: arc,
    conversationId: opts.conversationId,
    source: 'claude',
    startedAt: '2026-05-20T12:00:00.000Z',
    intent: '',
    slotValues: { files: [], tools: [], libraries: [], mcps: [] },
    resolutionSteps: [],
    outcome: 'succeeded',
    stableApproach: true,
    subGoals: [],
    toolSignature: [],
    invokedSkills: [],
    verbatimUserPrompts: [],
    correctionMarkers: opts.correctionMarkers ?? [],
    personalizationSignals: opts.personalizationSignals ?? [],
  }
}

function cluster(id: string, arcIds: string[]): IntentCluster {
  return {
    clusterId: id,
    members: arcIds,
    centroidIntent: '',
    centroidSlotValues: {},
    recurrenceCount: arcIds.length,
    dateSpan: { start: '', end: '' },
    medianGapDays: 0,
    recencyDays: 0,
    commonToolSignature: [],
    convergentApproach: [],
    outcomeBreakdown: { succeeded: arcIds.length, failed: 0, abandoned: 0, partial: 0 },
  }
}

const ALWAYS_TS = 'Always use TypeScript for new files in the server'
const ALWAYS_TS_ALT = 'Always use TypeScript for new files in the server side'

const SAY_YES = async (texts: string[]): Promise<boolean[]> => texts.map(() => true)
const SAY_NO = async (texts: string[]): Promise<boolean[]> => texts.map(() => false)

// ---- matchDirective ---------------------------------------------------------

describe('matchDirective', () => {
  it('recognizes always/never/prefer/avoid as Conventions', () => {
    expect(rulesTest.matchDirective('always X')).toBe('Conventions')
    expect(rulesTest.matchDirective('never Y')).toBe('Conventions')
    expect(rulesTest.matchDirective('prefer Z over W')).toBe('Conventions')
    expect(rulesTest.matchDirective('avoid foo')).toBe('Conventions')
  })

  it('returns null for non-directive text', () => {
    expect(rulesTest.matchDirective('I think we should try X')).toBeNull()
  })
})

// ---- ruleMarkers helpers ----------------------------------------------------

describe('ruleMarkers', () => {
  it('marker id is stable across calls', () => {
    const a = computeRuleMarkerId(ALWAYS_TS, 'Conventions')
    const b = computeRuleMarkerId(ALWAYS_TS, 'Conventions')
    expect(a).toBe(b)
    expect(a).toHaveLength(16)
  })

  it('marker id differs when section differs', () => {
    expect(computeRuleMarkerId(ALWAYS_TS, 'Conventions'))
      .not.toBe(computeRuleMarkerId(ALWAYS_TS, 'Tooling'))
  })

  it('extractRuleMarkerIds parses start markers from a body', () => {
    const body = [
      'Some text',
      ruleMarkerStart('aaaa1111'),
      'rule body',
      ruleMarkerEnd('aaaa1111'),
      '',
      ruleMarkerStart('bbbb2222'),
      'rule body 2',
      ruleMarkerEnd('bbbb2222'),
    ].join('\n')
    const ids = extractRuleMarkerIds(body)
    expect(ids.has('aaaa1111')).toBe(true)
    expect(ids.has('bbbb2222')).toBe(true)
    expect(ids.size).toBe(2)
  })
})

// ---- detectRules end-to-end -------------------------------------------------

describe('detectRules', () => {
  it('"always use TypeScript" across 6 conversations → 1 rule candidate', async () => {
    const summaries = Array.from({ length: 6 }, (_, i) =>
      summary({
        conversationId: `conv-${i}`,
        personalizationSignals: [{ kind: 'language', evidence: ALWAYS_TS }],
      }))
    const out = await detectRules(summaries, [], { llmClassifier: SAY_YES })
    expect(out).toHaveLength(1)
    expect(out[0].suggestedType).toBe('rule')
    expect(out[0].ruleText).toBe(ALWAYS_TS)
    expect(out[0].suggestedSection).toBe('Conventions')
  })

  it('rule whose marker is already in CLAUDE.md is skipped', async () => {
    const summaries = Array.from({ length: 6 }, (_, i) =>
      summary({
        conversationId: `conv-${i}`,
        personalizationSignals: [{ kind: 'language', evidence: ALWAYS_TS }],
      }))
    const markerId = computeRuleMarkerId(ALWAYS_TS, 'Conventions')
    const existing: ExistingRuleFile[] = [{
      file: '/fake/CLAUDE.md',
      source: 'claude',
      body: `${ruleMarkerStart(markerId)}\n${ALWAYS_TS}\n${ruleMarkerEnd(markerId)}`,
      markerIds: new Set([markerId]),
    }]
    const out = await detectRules(summaries, [], { llmClassifier: SAY_YES, existingRuleFiles: existing })
    expect(out).toEqual([])
  })

  it('classifier that throws drops all directives (LOC-79 batch-1 fix)', async () => {
    // Previous behavior: classifier failure fell back to all-true, polluting
    // CLAUDE.md with un-classified directives. Now: failure drops everything
    // so the bad path can't write to the user's global instructions.
    const summaries = Array.from({ length: 6 }, (_, i) =>
      summary({
        conversationId: `conv-${i}`,
        personalizationSignals: [{ kind: 'language', evidence: ALWAYS_TS }],
      }))
    const out = await detectRules(summaries, [], {
      llmClassifier: async () => { throw new Error('ollama down') },
    })
    expect(out).toEqual([])
  })

  it('classifier returning wrong-length array drops everything (LOC-79 batch-1 fix)', async () => {
    // Two DISTINCT directives so the grouper produces 2 separate candidates;
    // classifier returns only 1 entry → length mismatch → fallback to drop.
    const summaries = [
      ...Array.from({ length: 6 }, (_, i) =>
        summary({
          conversationId: `ts-conv-${i}`,
          personalizationSignals: [{ kind: 'language', evidence: 'Always use TypeScript on the server' }],
        })),
      ...Array.from({ length: 6 }, (_, i) =>
        summary({
          conversationId: `prettier-conv-${i}`,
          personalizationSignals: [{ kind: 'style', evidence: 'Always run prettier before committing' }],
        })),
    ]
    const out = await detectRules(summaries, [], {
      // Length mismatch (2 input → 1 output) — alignment isn't safe so we
      // can't trust ANY entry. Conservative drop.
      llmClassifier: async (_xs) => [true],
    })
    expect(out).toEqual([])
  })

  it('rule that the classifier rejects is dropped', async () => {
    const summaries = Array.from({ length: 6 }, (_, i) =>
      summary({
        conversationId: `conv-${i}`,
        personalizationSignals: [{ kind: 'language', evidence: ALWAYS_TS }],
      }))
    const out = await detectRules(summaries, [], { llmClassifier: SAY_NO })
    expect(out).toEqual([])
  })

  it('threshold: < minConversations → no candidates', async () => {
    const summaries = Array.from({ length: 4 }, (_, i) =>
      summary({
        conversationId: `conv-${i}`,
        personalizationSignals: [{ kind: 'language', evidence: ALWAYS_TS }],
      }))
    // Default minConversations = 5
    const out = await detectRules(summaries, [], { llmClassifier: SAY_YES })
    expect(out).toEqual([])
  })

  it('directive confined to a single cluster is dropped (task-specific)', async () => {
    const summaries = Array.from({ length: 6 }, (_, i) =>
      summary({
        conversationId: `conv-${i}`,
        personalizationSignals: [{ kind: 'language', evidence: ALWAYS_TS }],
      }))
    const c = cluster('cluster-0', summaries.map(s => s.arcId))
    const out = await detectRules(summaries, [c], { llmClassifier: SAY_YES })
    expect(out).toEqual([])
  })

  it('directive across two clusters survives the spread check', async () => {
    const summaries = Array.from({ length: 6 }, (_, i) =>
      summary({
        conversationId: `conv-${i}`,
        personalizationSignals: [{ kind: 'language', evidence: ALWAYS_TS }],
      }))
    const half = summaries.length / 2
    const c1 = cluster('cluster-0', summaries.slice(0, half).map(s => s.arcId))
    const c2 = cluster('cluster-1', summaries.slice(half).map(s => s.arcId))
    const out = await detectRules(summaries, [c1, c2], { llmClassifier: SAY_YES })
    expect(out).toHaveLength(1)
  })

  it('semantically similar text in existing file is skipped via embedFn', async () => {
    const summaries = Array.from({ length: 6 }, (_, i) =>
      summary({
        conversationId: `conv-${i}`,
        personalizationSignals: [{ kind: 'language', evidence: ALWAYS_TS }],
      }))
    const existing: ExistingRuleFile[] = [{
      file: '/fake/CLAUDE.md',
      source: 'claude',
      body: 'We always use TypeScript on the server side.',
      markerIds: new Set(),
    }]
    // Same vector for both → cosine sim = 1 → skip.
    const embedFn = async (): Promise<number[]> => [1, 0]
    const out = await detectRules(summaries, [], {
      llmClassifier: SAY_YES,
      existingRuleFiles: existing,
      embedFn,
      similarityThreshold: 0.7,
    })
    expect(out).toEqual([])
  })

  it('near-duplicate directives across conversations group into one candidate', async () => {
    const summaries = [
      ...Array.from({ length: 3 }, (_, i) =>
        summary({
          conversationId: `conv-${i}`,
          personalizationSignals: [{ kind: 'language', evidence: ALWAYS_TS }],
        })),
      ...Array.from({ length: 3 }, (_, i) =>
        summary({
          conversationId: `conv-${i + 3}`,
          personalizationSignals: [{ kind: 'language', evidence: ALWAYS_TS_ALT }],
        })),
    ]
    const out = await detectRules(summaries, [], { llmClassifier: SAY_YES })
    expect(out).toHaveLength(1)
    // Canonical is the longest.
    expect(out[0].ruleText).toBe(ALWAYS_TS_ALT)
  })

  it('emits at most 1 LLM call for the entire detection (batch classifier)', async () => {
    const summaries = Array.from({ length: 6 }, (_, i) =>
      summary({
        conversationId: `conv-${i}`,
        personalizationSignals: [{ kind: 'language', evidence: ALWAYS_TS }],
      }))
    let calls = 0
    const llmClassifier = async (texts: string[]): Promise<boolean[]> => {
      calls += 1
      return texts.map(() => true)
    }
    await detectRules(summaries, [], { llmClassifier })
    expect(calls).toBe(1)
  })

  it('signature is rule::<markerId> so re-runs are idempotent', async () => {
    const summaries = Array.from({ length: 6 }, (_, i) =>
      summary({
        conversationId: `conv-${i}`,
        personalizationSignals: [{ kind: 'language', evidence: ALWAYS_TS }],
      }))
    const out = await detectRules(summaries, [], { llmClassifier: SAY_YES })
    expect(out[0].signature).toBe(`rule::${computeRuleMarkerId(ALWAYS_TS, 'Conventions')}`)
  })
})

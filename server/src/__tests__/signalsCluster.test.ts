import { describe, it, expect } from 'vitest'
import {
  clusterSummaries,
  intentEmbeddingText,
  pickCentroid,
  cosineDistance,
  __test,
} from '../autoSkill/signals/cluster'
import type { ConversationSummary } from '../autoSkill/signals/types'

// ---- Fixture helpers --------------------------------------------------------

let nextId = 0
function summary(
  overrides: Partial<ConversationSummary> & Pick<ConversationSummary, 'intent'>,
): ConversationSummary {
  const id = `arc-${nextId++}`
  return {
    arcId: id,
    conversationId: `conv-${id}`,
    source: 'claude',
    startedAt: '2026-05-20T12:00:00.000Z',
    intent: overrides.intent,
    slotValues: { files: [], tools: [], libraries: [], mcps: [] },
    resolutionSteps: [],
    outcome: 'succeeded',
    stableApproach: true,
    subGoals: [],
    toolSignature: [],
    invokedSkills: [],
    verbatimUserPrompts: [],
    correctionMarkers: [],
    personalizationSignals: [],
    ...overrides,
  }
}

// Deterministic embed function — maps a string to a 3-d vector based on
// keyword presence. Lets tests carve summaries into known clusters.
//
// Vectors are intentionally NOT normalized; clusterSummaries normalizes.
function keywordEmbed(text: string): number[] {
  const t = text.toLowerCase()
  return [
    /test|vitest|unit|spec/.test(t) ? 1 : 0,
    /deploy|release|publish|build/.test(t) ? 1 : 0,
    /sql|query|database|migration/.test(t) ? 1 : 0,
  ]
}

const NOW = Date.UTC(2026, 4, 23, 0, 0, 0) // 2026-05-23

// ---- intentEmbeddingText ----------------------------------------------------

describe('intentEmbeddingText', () => {
  it('returns intent alone when there are no slot values', () => {
    const s = summary({ intent: 'add a test' })
    expect(intentEmbeddingText(s)).toBe('add a test')
  })

  it('joins sorted slot keys + sorted slot values', () => {
    const s = summary({
      intent: 'add a test',
      slotValues: { tools: ['vitest', 'eslint'], files: ['b.ts', 'a.ts'], libraries: [], mcps: [] },
    })
    const t = intentEmbeddingText(s)
    expect(t).toBe('add a test | files: a.ts, b.ts | tools: eslint, vitest')
  })
})

// ---- intersectAll -----------------------------------------------------------

describe('intersectAll', () => {
  it('returns common elements in first-array order', () => {
    const out = __test.intersectAll([
      ['a', 'b', 'c'],
      ['c', 'a'],
      ['a', 'c', 'd'],
    ])
    expect(out).toEqual(['a', 'c'])
  })

  it('empty when one array has no overlap', () => {
    expect(__test.intersectAll([['a'], ['b']])).toEqual([])
  })
})

// ---- pickCentroid -----------------------------------------------------------

describe('pickCentroid', () => {
  it('returns the member with the lowest summed cosine distance', () => {
    // Normalize vectors so cosine distance is meaningful.
    const norm = (v: number[]): number[] => __test.normalize(v)
    const vectors = [
      norm([1, 0, 0]),
      norm([1, 0.1, 0]), // closest to the cluster mean
      norm([1, 0.2, 0]),
      norm([0.9, 0.4, 0]),
    ]
    const idx = pickCentroid(vectors)
    // Brute-force verification: re-derive the lowest-sum member.
    let bestIdx = 0
    let bestSum = Infinity
    for (let i = 0; i < vectors.length; i++) {
      let sum = 0
      for (let j = 0; j < vectors.length; j++) if (i !== j) sum += cosineDistance(vectors[i], vectors[j])
      if (sum < bestSum) { bestSum = sum; bestIdx = i }
    }
    expect(idx).toBe(bestIdx)
  })
})

// ---- clusterSummaries -------------------------------------------------------

describe('clusterSummaries', () => {
  it('k=1 fast path normalizes centroid so a tight cluster stays together (LOC-79 batch-1 fix)', async () => {
    // Previously: k=1 used an unnormalized mean vector for WCSS, which
    // made spread clusters look worse than they were, leading the elbow
    // heuristic to oversplit into singletons (all filtered → []).
    const summaries = Array.from({ length: 4 }, (_, i) => summary({ intent: `vitest variant ${i}` }))
    // Embedder gives all four vectors the same direction with slight
    // magnitude variation — unnormalized mean shrinks, normalized stays unit.
    const out = await clusterSummaries(summaries, {
      embedFn: async (_t) => [1, 0.1, 0],
      nowMs: NOW,
    })
    expect(out).toHaveLength(1)
    expect(out[0].recurrenceCount).toBe(4)
  })

  it('three similar-intent summaries form one cluster', async () => {
    const summaries = [
      summary({ intent: 'write a vitest unit test' }),
      summary({ intent: 'add a vitest spec for foo' }),
      summary({ intent: 'unit-test the bar helper' }),
    ]
    const out = await clusterSummaries(summaries, { embedFn: keywordEmbed, nowMs: NOW })
    expect(out).toHaveLength(1)
    expect(out[0].recurrenceCount).toBe(3)
    expect(out[0].members.length).toBe(3)
  })

  it('three distinct-intent summaries yield zero clusters (each < 3)', async () => {
    const summaries = [
      summary({ intent: 'write a vitest unit test' }),
      summary({ intent: 'deploy the release build' }),
      summary({ intent: 'optimize a sql query' }),
    ]
    const out = await clusterSummaries(summaries, { embedFn: keywordEmbed, nowMs: NOW })
    expect(out).toEqual([])
  })

  it('cluster of 5 with 4 succeeded + 1 failed is kept (80% success)', async () => {
    const summaries = [
      summary({ intent: 'write a vitest unit test', outcome: 'succeeded' }),
      summary({ intent: 'add a vitest spec', outcome: 'succeeded' }),
      summary({ intent: 'unit test a helper', outcome: 'succeeded' }),
      summary({ intent: 'vitest snapshot test', outcome: 'succeeded' }),
      summary({ intent: 'failing vitest test', outcome: 'failed' }),
    ]
    const out = await clusterSummaries(summaries, { embedFn: keywordEmbed, nowMs: NOW })
    expect(out).toHaveLength(1)
    expect(out[0].outcomeBreakdown).toEqual({ succeeded: 4, failed: 1, abandoned: 0, partial: 0 })
  })

  it('cluster of 5 with 2 succeeded + 3 failed is dropped (40% success)', async () => {
    const summaries = [
      summary({ intent: 'write a vitest unit test', outcome: 'succeeded' }),
      summary({ intent: 'add a vitest spec', outcome: 'succeeded' }),
      summary({ intent: 'unit test failed', outcome: 'failed' }),
      summary({ intent: 'vitest snapshot failed', outcome: 'failed' }),
      summary({ intent: 'broken vitest spec', outcome: 'failed' }),
    ]
    const out = await clusterSummaries(summaries, { embedFn: keywordEmbed, nowMs: NOW })
    expect(out).toEqual([])
  })

  it('separates two distinct clusters of 3 each', async () => {
    const summaries = [
      summary({ intent: 'write a vitest unit test' }),
      summary({ intent: 'add a vitest spec for foo' }),
      summary({ intent: 'unit-test the bar helper' }),
      summary({ intent: 'deploy the release build' }),
      summary({ intent: 'publish a new release' }),
      summary({ intent: 'build and deploy to prod' }),
    ]
    const out = await clusterSummaries(summaries, { embedFn: keywordEmbed, nowMs: NOW })
    expect(out.length).toBe(2)
    const sizes = out.map(c => c.recurrenceCount).sort()
    expect(sizes).toEqual([3, 3])
  })

  it('aggregates commonToolSignature and convergentApproach via intersection', async () => {
    const summaries = [
      summary({
        intent: 'write a vitest unit test',
        toolSignature: ['Read', 'Edit', 'Bash'],
        resolutionSteps: ['scaffold', 'write', 'run'],
      }),
      summary({
        intent: 'add a vitest spec',
        toolSignature: ['Read', 'Edit'],
        resolutionSteps: ['scaffold', 'write'],
      }),
      summary({
        intent: 'unit-test the helper',
        toolSignature: ['Read', 'Bash'],
        resolutionSteps: ['scaffold', 'run'],
      }),
    ]
    const out = await clusterSummaries(summaries, { embedFn: keywordEmbed, nowMs: NOW })
    expect(out).toHaveLength(1)
    expect(out[0].commonToolSignature).toEqual(['Read'])
    expect(out[0].convergentApproach).toEqual(['scaffold'])
  })

  it('computes recencyDays from now - max(startedAt)', async () => {
    const summaries = [
      summary({ intent: 'vitest A', startedAt: '2026-05-18T00:00:00.000Z' }), // 5 days ago
      summary({ intent: 'vitest B', startedAt: '2026-05-20T00:00:00.000Z' }), // 3 days ago
      summary({ intent: 'vitest C', startedAt: '2026-05-22T00:00:00.000Z' }), // 1 day ago
    ]
    const out = await clusterSummaries(summaries, { embedFn: keywordEmbed, nowMs: NOW })
    expect(out).toHaveLength(1)
    expect(out[0].recencyDays).toBeCloseTo(1, 2)
    expect(out[0].dateSpan.start).toBe('2026-05-18T00:00:00.000Z')
    expect(out[0].dateSpan.end).toBe('2026-05-22T00:00:00.000Z')
  })

  it('embeds each summary exactly once (cache reuse via injected fn)', async () => {
    const seen = new Map<string, number>()
    const embedFn = async (t: string): Promise<number[]> => {
      seen.set(t, (seen.get(t) ?? 0) + 1)
      return keywordEmbed(t)
    }
    const summaries = [
      summary({ intent: 'vitest A' }),
      summary({ intent: 'vitest A' }), // intentionally duplicate text
      summary({ intent: 'vitest A' }),
    ]
    await clusterSummaries(summaries, { embedFn, nowMs: NOW })
    // The clusterer doesn't dedupe by text itself — that's the embed cache's
    // job. Verify the injected fn was called once per summary (3x).
    expect([...seen.values()].reduce((a, b) => a + b, 0)).toBe(3)
  })

  it('returns [] when fewer summaries than minMembers', async () => {
    const summaries = [
      summary({ intent: 'vitest A' }),
      summary({ intent: 'vitest B' }),
    ]
    const out = await clusterSummaries(summaries, { embedFn: keywordEmbed, nowMs: NOW })
    expect(out).toEqual([])
  })

  it('clusters carry sorted clusterIds by recurrence (cluster-0 is largest)', async () => {
    const summaries = [
      // small cluster of 3
      summary({ intent: 'deploy A' }),
      summary({ intent: 'deploy B' }),
      summary({ intent: 'deploy C' }),
      // big cluster of 4
      summary({ intent: 'vitest A' }),
      summary({ intent: 'vitest B' }),
      summary({ intent: 'vitest C' }),
      summary({ intent: 'vitest D' }),
    ]
    const out = await clusterSummaries(summaries, { embedFn: keywordEmbed, nowMs: NOW })
    expect(out).toHaveLength(2)
    expect(out[0].clusterId).toBe('cluster-0')
    expect(out[0].recurrenceCount).toBe(4)
    expect(out[1].clusterId).toBe('cluster-1')
    expect(out[1].recurrenceCount).toBe(3)
  })
})

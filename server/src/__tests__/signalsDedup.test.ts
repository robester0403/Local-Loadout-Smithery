import { describe, it, expect } from 'vitest'
import { deduplicateCandidates, type ExistingArtifact } from '../autoSkill/signals/dedup'
import type { Candidate } from '../autoSkill/types'

type Gen = Omit<Candidate, 'id' | 'status' | 'createdAt' | 'updatedAt'>

function cand(
  kind: Candidate['suggestedType'],
  name: string,
  description: string,
): Gen {
  return {
    signature: `${kind}::${name}`,
    name,
    description,
    bodyDraft: '',
    suggestedType: kind,
    score: 0,
    sourceRefs: [],
    model: 'test',
  }
}

function artifact(kind: Candidate['suggestedType'], name: string, description: string): ExistingArtifact {
  return { id: `art-${name}`, name, path: `/fake/${name}.md`, description, kind }
}

// Deterministic embedder: hash name+description into a 3-d vector.
// Same string → same vector → cosine sim = 1.
const sameTextEmbed = async (text: string): Promise<number[]> => {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return [Math.sin(h), Math.cos(h), Math.sin(h * 2)]
}

describe('deduplicateCandidates', () => {
  it('passes through candidates with no existing library', async () => {
    const cs = [cand('skill', 'add-vitest-spec', 'Scaffold a vitest test')]
    const out = await deduplicateCandidates(cs, [], { embedFn: sameTextEmbed })
    expect(out[0].existingMatch).toBeUndefined()
  })

  it('marks existingMatch when description matches an existing same-kind artifact', async () => {
    const cs = [cand('skill', 'review-pr', 'Walk through the diff and flag issues')]
    const ex = [artifact('skill', 'review-pr', 'Walk through the diff and flag issues')]
    const out = await deduplicateCandidates(cs, ex, { embedFn: sameTextEmbed })
    expect(out[0].existingMatch).toBeDefined()
    expect(out[0].existingMatch?.skillName).toBe('review-pr')
    expect(out[0].existingMatch?.matchKind).toBe('description')
    expect(out[0].existingMatch?.similarity).toBeCloseTo(1, 3)
  })

  it('DOES dedup across different kinds and records the matched artifact kind (LOC-89)', async () => {
    const cs = [cand('skill', 'review-pr', 'walk through diff')]
    const ex = [artifact('command', 'review-pr', 'walk through diff')]
    const out = await deduplicateCandidates(cs, ex, { embedFn: sameTextEmbed })
    expect(out[0].existingMatch).toBeDefined()
    expect(out[0].existingMatch?.kind).toBe('command')
    expect(out[0].existingMatch?.skillName).toBe('review-pr')
    expect(out[0].existingMatch?.similarity).toBeCloseTo(1, 3)
  })

  it('records kind on same-kind matches too', async () => {
    const cs = [cand('skill', 'review-pr', 'Walk through the diff and flag issues')]
    const ex = [artifact('skill', 'review-pr', 'Walk through the diff and flag issues')]
    const out = await deduplicateCandidates(cs, ex, { embedFn: sameTextEmbed })
    expect(out[0].existingMatch?.kind).toBe('skill')
  })

  it('keeps candidate unflagged when no existing artifact passes the threshold', async () => {
    const cs = [cand('skill', 'add-vitest-spec', 'Scaffold a vitest test')]
    const ex = [artifact('skill', 'deploy-release', 'Cut a release branch and tag')]
    const out = await deduplicateCandidates(cs, ex, { embedFn: sameTextEmbed })
    expect(out[0].existingMatch).toBeUndefined()
  })

  it('picks the most-similar existing match when multiple same-kind exist', async () => {
    const cs = [cand('skill', 'add-vitest-spec', 'Scaffold a vitest test')]
    const ex = [
      artifact('skill', 'deploy-release', 'Cut a release branch and tag'),
      artifact('skill', 'add-vitest-spec', 'Scaffold a vitest test'), // exact match
      artifact('skill', 'lint-files', 'Run ESLint over staged files'),
    ]
    const out = await deduplicateCandidates(cs, ex, { embedFn: sameTextEmbed })
    expect(out[0].existingMatch?.skillName).toBe('add-vitest-spec')
  })

  it('respects similarityThreshold override', async () => {
    const cs = [cand('skill', 'review-pr', 'walk through diff')]
    const ex = [artifact('skill', 'review-pr', 'walk through diff')]
    // Exact match → sim = 1; threshold 1.01 means impossible.
    const out = await deduplicateCandidates(cs, ex, { embedFn: sameTextEmbed, similarityThreshold: 1.01 })
    expect(out[0].existingMatch).toBeUndefined()
  })
})

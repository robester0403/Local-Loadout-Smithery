import { describe, it, expect } from 'vitest'
import {
  collapseCrossDetector,
  rejectNameCollisions,
  __test as crossDedupTest,
} from '../autoSkill/signals/crossDedup'
import type { GeneratedCandidate, ExistingArtifact } from '../autoSkill/signals/dedup'
import type { Candidate } from '../autoSkill/types'

function cand(
  kind: Candidate['suggestedType'],
  name: string,
  description: string,
): GeneratedCandidate {
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

function artifact(kind: Candidate['suggestedType'], name: string, description = ''): ExistingArtifact {
  return { id: `art-${name}`, name, path: `/fake/${name}.md`, description, kind }
}

// Deterministic embedder identical to the one in signalsDedup.test.ts —
// same text yields identical vectors, so cosine sim = 1.0 for matches.
const sameTextEmbed = async (text: string): Promise<number[]> => {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return [Math.sin(h), Math.cos(h), Math.sin(h * 2)]
}

describe('crossDedup.slugify', () => {
  it('matches emit.ts sanitizeName behavior', () => {
    expect(crossDedupTest.slugify('My Skill Name!')).toBe('my-skill-name')
    expect(crossDedupTest.slugify('  spaced  out  ')).toBe('spaced-out')
    expect(crossDedupTest.slugify('UPPER-case_thing')).toBe('upper-case-thing')
  })
})

describe('crossDedup.TYPE_PRIORITY', () => {
  it('orders skill > subagent > command > rule', () => {
    const p = crossDedupTest.priority
    expect(p('skill')).toBeGreaterThan(p('subagent'))
    expect(p('subagent')).toBeGreaterThan(p('command'))
    expect(p('command')).toBeGreaterThan(p('rule'))
  })
})

describe('collapseCrossDetector', () => {
  it('passes through when fewer than 2 candidates', async () => {
    const out = await collapseCrossDetector([cand('skill', 'foo', 'bar')], { embedFn: sameTextEmbed })
    expect(out.kept).toHaveLength(1)
    expect(out.dropped).toHaveLength(0)
  })

  it('collapses semantically-equivalent candidates emitted by different detectors, keeping the higher-priority type', async () => {
    const cs = [
      cand('command', 'format-changelog', 'Reformat the CHANGELOG into Keep-a-Changelog style'),
      cand('skill',   'format-changelog', 'Reformat the CHANGELOG into Keep-a-Changelog style'),
    ]
    const out = await collapseCrossDetector(cs, { embedFn: sameTextEmbed })
    expect(out.kept).toHaveLength(1)
    expect(out.kept[0].suggestedType).toBe('skill')
    expect(out.dropped).toHaveLength(1)
    expect(out.dropped[0].candidate.suggestedType).toBe('command')
    expect(out.dropped[0].reason).toMatch(/cross-detector duplicate/)
  })

  it('keeps both when below threshold', async () => {
    const cs = [
      cand('skill', 'totally-different-one', 'thing alpha'),
      cand('command', 'unrelated-other', 'thing beta'),
    ]
    const out = await collapseCrossDetector(cs, { embedFn: sameTextEmbed })
    expect(out.kept).toHaveLength(2)
    expect(out.dropped).toHaveLength(0)
  })

  it('keeps same-type duplicates (cross-DETECTOR only — same-type dupe is the upserter\'s job)', async () => {
    const cs = [
      cand('skill', 'foo', 'identical description'),
      cand('skill', 'foo-copy', 'identical description'),
    ]
    const out = await collapseCrossDetector(cs, { embedFn: sameTextEmbed })
    // Both are skill, same priority — collapse logic only drops lower-priority,
    // so neither is removed when priorities tie.
    expect(out.kept).toHaveLength(2)
  })
})

describe('rejectNameCollisions', () => {
  it('drops candidate whose slug collides with another candidate of lower priority', () => {
    const cs = [
      cand('command', 'foo bar', 'desc A'),
      cand('skill',   'foo-bar', 'desc B'),
    ]
    const out = rejectNameCollisions(cs, [])
    expect(out.kept).toHaveLength(1)
    expect(out.kept[0].suggestedType).toBe('skill')
    expect(out.dropped[0].candidate.suggestedType).toBe('command')
    expect(out.dropped[0].reason).toMatch(/already claimed by skill/)
  })

  it('drops candidate whose slug collides with an existing artifact of any type', () => {
    const cs = [cand('skill', 'my-helper', 'a new skill')]
    const existing = [artifact('command', 'my-helper', 'an old command')]
    const out = rejectNameCollisions(cs, existing)
    expect(out.kept).toHaveLength(0)
    expect(out.dropped).toHaveLength(1)
    expect(out.dropped[0].reason).toMatch(/collides with existing command/)
  })

  it('keeps both when slugs differ', () => {
    const cs = [
      cand('skill', 'foo', 'a'),
      cand('command', 'bar', 'b'),
    ]
    const out = rejectNameCollisions(cs, [])
    expect(out.kept).toHaveLength(2)
    expect(out.dropped).toHaveLength(0)
  })

  it('drops candidate whose name sanitizes to an empty slug', () => {
    const cs = [cand('skill', '!!!', 'unusable name')]
    const out = rejectNameCollisions(cs, [])
    expect(out.kept).toHaveLength(0)
    expect(out.dropped[0].reason).toMatch(/empty slug/)
  })
})

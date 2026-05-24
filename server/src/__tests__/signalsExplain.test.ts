import { describe, it, expect } from 'vitest'
import { generateReasonForUser, annotateWithReason } from '../autoSkill/signals/explain'
import type { Candidate } from '../autoSkill/types'
import type { IntentCluster } from '../autoSkill/signals/types'

type Gen = Omit<Candidate, 'id' | 'status' | 'createdAt' | 'updatedAt'>

function base(kind: Candidate['suggestedType']): Gen {
  return {
    signature: `${kind}::test`,
    name: 'test',
    description: 'test',
    bodyDraft: '',
    suggestedType: kind,
    score: 0,
    sourceRefs: [],
    model: 'test',
  }
}

function ref(conversationId: string, at: string): Candidate['sourceRefs'][number] {
  return { source: 'claude', conversationId, excerpt: '', at }
}

describe('generateReasonForUser', () => {
  it('skill reason uses cluster stats when cluster is supplied', () => {
    const c: Gen = {
      ...base('skill'),
      sourceClusterId: 'c-1',
    }
    const clusters = new Map<string, IntentCluster>([
      ['c-1', {
        clusterId: 'c-1',
        members: [],
        centroidIntent: '',
        centroidSlotValues: {},
        recurrenceCount: 7,
        dateSpan: { start: '2026-05-05T00:00:00.000Z', end: '2026-05-21T00:00:00.000Z' },
        medianGapDays: 0,
        recencyDays: 0,
        commonToolSignature: [],
        convergentApproach: [],
        outcomeBreakdown: { succeeded: 6, failed: 1, abandoned: 0, partial: 0 },
      }],
    ])
    const reason = generateReasonForUser(c, { clustersById: clusters })
    expect(reason).toContain('7 conversations')
    expect(reason).toContain('2026-05-21')
    expect(reason).toContain('6 of 7')
  })

  it('skill reason falls back to sourceRefs when no cluster', () => {
    const c = { ...base('skill'), sourceRefs: [ref('a', '2026-05-22T00:00:00.000Z'), ref('b', '2026-05-22T00:00:00.000Z')] }
    const reason = generateReasonForUser(c)
    expect(reason).toContain('2 conversations')
    expect(reason).toContain('2026-05-22')
  })

  it('command reason interpolates invocation + conversation counts', () => {
    const c: Gen = {
      ...base('command'),
      invocationCount: 4,
      sourceRefs: [
        ref('c1', '2026-05-20T00:00:00.000Z'),
        ref('c2', '2026-05-21T00:00:00.000Z'),
        ref('c3', '2026-05-22T00:00:00.000Z'),
      ],
    }
    const reason = generateReasonForUser(c)
    expect(reason).toContain('4 times')
    expect(reason).toContain('3 conversations')
    expect(reason).toContain('2026-05-22')
  })

  it('subagent reason lists constituent skills', () => {
    const c: Gen = {
      ...base('subagent'),
      constituentSkills: ['pr-review', 'run-tests', 'write-changelog'],
      sourceClusterId: 'subagent-pattern::pr-review||run-tests||write-changelog',
      sourceRefs: [ref('a', '2026-05-21T00:00:00.000Z'), ref('b', '2026-05-21T00:00:00.000Z'), ref('c', '2026-05-21T00:00:00.000Z')],
    }
    const reason = generateReasonForUser(c)
    expect(reason).toContain('[pr-review, run-tests, write-changelog]')
    expect(reason).toContain('3 conversations')
    // No custom steps in this pattern → reason doesn't mention "interleaved".
    expect(reason).not.toContain('interleaved')
  })

  it('subagent reason flags interleaved custom steps when pattern includes __custom (LOC-79 batch-1 fix)', () => {
    // Previous behavior: claimed "you ran skills [A, B] in this sequence"
    // even when the mined pattern was [A, __custom, B]. False claim. Now:
    // the reason explicitly calls out the interleaved custom work.
    const c: Gen = {
      ...base('subagent'),
      constituentSkills: ['pr-review', 'run-tests'],
      sourceClusterId: 'subagent-pattern::pr-review||__custom||run-tests',
      sourceRefs: [ref('a', '2026-05-21T00:00:00.000Z'), ref('b', '2026-05-21T00:00:00.000Z'), ref('c', '2026-05-21T00:00:00.000Z')],
    }
    const reason = generateReasonForUser(c)
    expect(reason).toContain('interleaved with custom steps')
    expect(reason).toContain('[pr-review, run-tests]')
  })

  it('rule reason calls out always-on convention shape', () => {
    const c: Gen = {
      ...base('rule'),
      ruleText: 'Always use TypeScript',
      sourceRefs: Array.from({ length: 8 }, (_, i) => ref(`r-${i}`, '2026-05-22T00:00:00.000Z')),
    }
    const reason = generateReasonForUser(c)
    expect(reason).toContain('8 conversations')
    expect(reason.toLowerCase()).toContain('always-on convention')
  })

  it('refinement candidates prepend the refinement preamble', () => {
    const c: Gen = {
      ...base('skill'),
      existingMatch: {
        skillId: 'art-1',
        skillName: 'existing-review',
        skillPath: '/fake/existing-review.md',
        matchKind: 'description',
        similarity: 0.92,
      },
      sourceRefs: [ref('a', '2026-05-21T00:00:00.000Z')],
    }
    const reason = generateReasonForUser(c)
    expect(reason).toContain('refines your existing skill')
    expect(reason).toContain('existing-review')
  })
})

describe('annotateWithReason', () => {
  it('populates reasonForUser when missing', () => {
    const c1 = { ...base('skill'), sourceRefs: [ref('a', '2026-05-22T00:00:00.000Z')] }
    const c2 = { ...base('command'), sourceRefs: [ref('a', '2026-05-22T00:00:00.000Z')] }
    const out = annotateWithReason([c1, c2])
    expect(out[0].reasonForUser).toBeTruthy()
    expect(out[1].reasonForUser).toBeTruthy()
  })

  it('preserves an existing reasonForUser without overwrite', () => {
    const c = {
      ...base('skill'),
      reasonForUser: 'pre-existing reason from elsewhere',
      sourceRefs: [ref('a', '2026-05-22T00:00:00.000Z')],
    }
    const out = annotateWithReason([c])
    expect(out[0].reasonForUser).toBe('pre-existing reason from elsewhere')
  })
})

import { describe, it, expect } from 'vitest'
import { findExistingMatch, __test } from '../harvester/matcher'
import type { Skill } from '../scanner/types'
import type { Candidate } from '../harvester/types'

function skill(name: string, description: string, type: Skill['type'] = 'skill', overrides: Partial<Skill> = {}): Skill {
  return {
    id: Buffer.from(`/${name}`).toString('base64'),
    name,
    description,
    version: '1.0.0',
    type,
    scope: 'global',
    account: 'default',
    path: `/${name}/SKILL.md`,
    realpath: `/${name}/SKILL.md`,
    isSymlink: false,
    body: '',
    bodyBytes: 0,
    bodyTokens: 0,
    listingBytes: 0,
    listingTokens: 0,
    frontmatter: {},
    lastModified: '2026-01-01T00:00:00.000Z',
    health: { status: 'ok', issues: [] },
    disabled: false,
    references: [],
    ...overrides,
  }
}

function candidate(name: string, description: string, type: Candidate['suggestedType'] = 'skill'): Candidate {
  return {
    id: 'cand-1', signature: 'sig', name, description, bodyDraft: '',
    suggestedType: type, score: 0.5, status: 'pending', sourceRefs: [],
    createdAt: '', updatedAt: '', model: 'qwen2.5:3b',
  }
}

describe('jaccard', () => {
  it('returns 1 for identical sets', () => {
    expect(__test.jaccard(__test.tokenize('the quick brown fox'), __test.tokenize('the quick brown fox'))).toBe(1)
  })
  it('returns 0 for disjoint sets', () => {
    expect(__test.jaccard(__test.tokenize('alpha beta'), __test.tokenize('gamma delta'))).toBe(0)
  })
})

describe('findExistingMatch', () => {
  it('returns null when no skills match', () => {
    const cand = candidate('totally-unique-name', 'When the user does something never before seen.')
    expect(findExistingMatch(cand, [skill('other', 'Unrelated description here.')])).toBeNull()
  })

  it('returns a name match with similarity 1.0 for exact slug match', () => {
    const cand = candidate('morning-plan', 'Run the morning workflow.')
    const m = findExistingMatch(cand, [skill('morning-plan', 'Some other description.')])
    expect(m?.matchKind).toBe('name')
    expect(m?.similarity).toBe(1)
  })

  it('catches description duplicates even when names differ', () => {
    const cand = candidate('analyze-integrations', 'Use when the user wants to analyze integration field usage.')
    const m = findExistingMatch(cand, [
      skill('integrations-field-analysis', 'Use when the user wants to analyze integration field usage data.'),
    ])
    expect(m?.matchKind).toBe('description')
    expect(m?.similarity).toBeGreaterThan(0.4)
  })

  it('does not cross types — a skill candidate is not matched against a command', () => {
    const cand = candidate('thing', 'Use when the user does the thing.', 'skill')
    const m = findExistingMatch(cand, [skill('thing', 'Use when the user does the thing.', 'command')])
    expect(m).toBeNull()
  })

  it('ignores disabled skills', () => {
    const cand = candidate('morning-plan', 'd')
    const m = findExistingMatch(cand, [skill('morning-plan', 'd', 'skill', { disabled: true })])
    expect(m).toBeNull()
  })
})

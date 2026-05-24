import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { upsertGenerated, readAll } from '../autoSkill/store'
import type { Candidate } from '../autoSkill/types'

let tmpHome: string
let realHomedir: () => string

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-store-'))
  realHomedir = os.homedir
  ;(os as { homedir: () => string }).homedir = () => tmpHome
})

afterEach(() => {
  ;(os as { homedir: () => string }).homedir = realHomedir
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ }
})

type Gen = Omit<Candidate, 'id' | 'status' | 'createdAt' | 'updatedAt'>

function makeCandidate(overrides: Partial<Gen> & Pick<Gen, 'signature' | 'suggestedType'>): Gen {
  return {
    name: 'test',
    description: 'test',
    bodyDraft: '',
    score: 0,
    sourceRefs: [{
      source: 'claude',
      conversationId: 'conv-1',
      excerpt: '',
      at: '2026-05-23T00:00:00.000Z',
    }],
    model: 'test-model',
    ...overrides,
  } as Gen
}

describe('upsertGenerated pendingPatch (LOC-79 batch-1 fix)', () => {
  it('first upsert persists all pipeline enrichment fields', () => {
    const c = makeCandidate({
      signature: 'rule::test-rule',
      suggestedType: 'rule',
      ruleText: 'Always X.',
      suggestedSection: 'Conventions',
      reasonForUser: 'Appeared in 8 conversations',
      evidenceQuotes: [{ conversationId: 'conv-1', quote: 'use X please' }],
    })
    const { created, candidate } = upsertGenerated(c)
    expect(created).toBe(true)
    expect(candidate.ruleText).toBe('Always X.')
    expect(candidate.reasonForUser).toBe('Appeared in 8 conversations')
  })

  it('second upsert without enrichment fields PRESERVES the first run\'s enrichment', () => {
    // Simulates: pipeline runs once (populates ruleText/reasonForUser/etc),
    // then user toggles useSignalPipeline OFF, the legacy digest runs and
    // re-upserts the same candidate without per-kind enrichment. Previously
    // this stripped the enrichment by writing `undefined`. Now: undefined
    // values are skipped in the merge.
    const first = makeCandidate({
      signature: 'skill::add-vitest-spec',
      suggestedType: 'skill',
      applicabilityCondition: 'When the user asks to add a vitest test',
      procedure: ['Read helper', 'Create *.test.ts', 'Run vitest'],
      terminationCondition: 'Test runs green',
      expectedOutput: 'A new .test.ts file',
      reasonForUser: 'Pattern in 7 conversations',
      sourceClusterId: 'cluster-1',
    })
    upsertGenerated(first)

    // Legacy-style emission: same signature, same name/description, but no
    // enrichment. Used to set the fields to undefined; now should leave them.
    const second = makeCandidate({
      signature: 'skill::add-vitest-spec',
      suggestedType: 'skill',
      bodyDraft: 'updated body from legacy digest',
    })
    const { created, candidate } = upsertGenerated(second)
    expect(created).toBe(false) // updated, not created

    // Body updates (was undefined → defined-on-LHS doesn't matter; this one
    // has a real value so it overwrites).
    expect(candidate.bodyDraft).toBe('updated body from legacy digest')

    // CRITICAL: enrichment fields survive.
    expect(candidate.applicabilityCondition).toBe('When the user asks to add a vitest test')
    expect(candidate.procedure).toEqual(['Read helper', 'Create *.test.ts', 'Run vitest'])
    expect(candidate.terminationCondition).toBe('Test runs green')
    expect(candidate.expectedOutput).toBe('A new .test.ts file')
    expect(candidate.reasonForUser).toBe('Pattern in 7 conversations')
    expect(candidate.sourceClusterId).toBe('cluster-1')

    // Persisted shape matches the in-memory return.
    const persisted = readAll().find(p => p.signature === 'skill::add-vitest-spec')
    expect(persisted?.applicabilityCondition).toBe('When the user asks to add a vitest test')
    expect(persisted?.procedure?.length).toBe(3)
  })

  it('second upsert WITH defined enrichment overwrites the first', () => {
    const first = makeCandidate({
      signature: 'rule::test-rule',
      suggestedType: 'rule',
      ruleText: 'Always X.',
      reasonForUser: 'Old reason',
    })
    upsertGenerated(first)

    const second = makeCandidate({
      signature: 'rule::test-rule',
      suggestedType: 'rule',
      ruleText: 'Always X (refined).',
      reasonForUser: 'New reason from second digest',
    })
    const { candidate } = upsertGenerated(second)

    expect(candidate.ruleText).toBe('Always X (refined).')
    expect(candidate.reasonForUser).toBe('New reason from second digest')
  })

  it('once status is accepted/rejected, neither path overwrites enrichment', () => {
    const first = makeCandidate({
      signature: 'skill::test',
      suggestedType: 'skill',
      applicabilityCondition: 'Original applicability',
      procedure: ['original step'],
      terminationCondition: 'Original termination',
      expectedOutput: 'Original output',
    })
    const { candidate: created } = upsertGenerated(first)
    // Simulate accept (would normally happen via emit.ts).
    // We use the persisted shape's id and update status directly via the
    // store's lower-level API by re-reading and writing through setStatus.
    // For this test we just verify the existing-but-not-pending guard works
    // — the simpler way is to mock the status by reading the persisted file
    // and writing it back with status=accepted, then upserting again.
    const dataPath = path.join(tmpHome, '.loadoutsmith', 'auto-skill', 'candidates.json')
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as { candidates: Candidate[] }
    data.candidates[0] = { ...data.candidates[0], status: 'accepted' }
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2))

    const second = makeCandidate({
      signature: 'skill::test',
      suggestedType: 'skill',
      applicabilityCondition: 'WOULD-OVERWRITE applicability',
      procedure: ['would-overwrite step'],
      terminationCondition: 'would-overwrite termination',
      expectedOutput: 'would-overwrite output',
    })
    upsertGenerated(second)

    const after = readAll().find(c => c.signature === 'skill::test')
    // Accepted candidates aren't re-templated; user-triaged fields stay frozen.
    expect(after?.applicabilityCondition).toBe('Original applicability')
    expect(after?.procedure).toEqual(['original step'])
    expect(after?.status).toBe('accepted')
    void created
  })
})

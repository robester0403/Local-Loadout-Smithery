import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mocks must be declared before the SUT is imported. We stub the
// scanner/discover (findAccounts) and the shared existingInventory loader
// so the emit guard sees a controlled inventory containing a cross-type
// collision.
const fakeInventory: Array<{ id: string; name: string; path: string; description: string; kind: 'skill' | 'command' | 'subagent' }> = []

vi.mock('../scanner/discover', () => ({
  findAccounts: () => ['/fake/.claude'],
  discoverAllSkills: () => fakeInventory.map(a => ({ ...a, type: a.kind, disabled: false })),
}))
vi.mock('../autoSkill/signals/existingInventory', () => ({
  loadExistingInventory: () => fakeInventory,
}))

import { emitFromCandidate } from '../autoSkill/emit'
import type { Candidate } from '../autoSkill/types'

function candidate(name: string, type: Candidate['suggestedType'] = 'skill'): Candidate {
  return {
    id: 'cand-1',
    signature: `${type}::${name}`,
    name,
    description: 'd',
    bodyDraft: 'b',
    suggestedType: type,
    score: 0,
    status: 'pending',
    sourceRefs: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    model: 'test',
  }
}

describe('emitFromCandidate cross-type slug collision (LOC-89)', () => {
  beforeEach(() => {
    fakeInventory.length = 0
  })

  it('throws 409 when accepting a skill whose slug collides with an existing command', () => {
    fakeInventory.push({
      id: 'existing-cmd', name: 'foo', path: '/fake/.claude/commands/foo.md',
      description: 'an old command', kind: 'command',
    })
    expect(() => emitFromCandidate(candidate('foo', 'skill'), {
      accountDir: '/fake/.claude', scope: 'global',
      name: 'foo', description: 'd', body: 'b', type: 'skill',
    })).toThrow(/Slug "foo" already used by existing command/)
  })

  it('throws 409 when accepting a command whose slug collides with an existing skill', () => {
    fakeInventory.push({
      id: 'existing-skill', name: 'helper', path: '/fake/.claude/skills/helper/SKILL.md',
      description: 'an old skill', kind: 'skill',
    })
    expect(() => emitFromCandidate(candidate('helper', 'command'), {
      accountDir: '/fake/.claude', scope: 'global',
      name: 'helper', description: 'd', body: 'b', type: 'command',
    })).toThrow(/Slug "helper" already used by existing skill/)
  })

  it('does NOT block same-type collisions here — those are handled by the destination-path existsSync check', () => {
    fakeInventory.push({
      id: 'existing-skill', name: 'same', path: '/fake/.claude/skills/same/SKILL.md',
      description: 'an old skill', kind: 'skill',
    })
    // Same-kind: the cross-type guard skips it (a.kind !== opts.type filter).
    // Behavior past this point isn't this test's concern — the call will fail
    // later on fs.existsSync or assertWithinHome. We just assert the guard
    // didn't fire its OWN 409 with the cross-type message.
    expect(() => emitFromCandidate(candidate('same', 'skill'), {
      accountDir: '/fake/.claude', scope: 'global',
      name: 'same', description: 'd', body: 'b', type: 'skill',
    })).not.toThrow(/Slug "same" already used by existing/)
  })
})

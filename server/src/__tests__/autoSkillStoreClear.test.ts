import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { clearByStatus, deleteById, readAll, setStatus, upsertGenerated } from '../autoSkill/store'
import type { Candidate } from '../autoSkill/types'

let tmpHome: string
let realHomedir: () => string

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-store-clear-'))
  realHomedir = os.homedir
  ;(os as { homedir: () => string }).homedir = () => tmpHome
})

afterEach(() => {
  ;(os as { homedir: () => string }).homedir = realHomedir
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ }
})

type Gen = Omit<Candidate, 'id' | 'status' | 'createdAt' | 'updatedAt'>

function seed(signature: string): Candidate {
  const gen: Gen = {
    signature,
    name: signature,
    description: '',
    bodyDraft: '',
    suggestedType: 'skill',
    score: 0.5,
    sourceRefs: [{
      source: 'claude',
      conversationId: `conv-${signature}`,
      excerpt: '',
      at: '2026-05-23T00:00:00.000Z',
    }],
    model: 'test',
  }
  return upsertGenerated(gen).candidate
}

describe('clearByStatus', () => {
  it('removes only pending candidates, leaves accepted + rejected alone', () => {
    const a = seed('skill::pending-1')
    const b = seed('skill::pending-2')
    const c = seed('skill::accepted-1')
    const d = seed('skill::rejected-1')

    setStatus(c.id, 'accepted', '/fake/path/SKILL.md')
    setStatus(d.id, 'rejected')

    const removed = clearByStatus('pending')

    expect(removed).toBe(2)
    const remaining = readAll()
    expect(remaining.map(r => r.signature).sort()).toEqual(['skill::accepted-1', 'skill::rejected-1'])
    void a; void b // silence unused
  })

  it('removes only rejected candidates when status is "rejected"', () => {
    const a = seed('skill::pending-1')
    const b = seed('skill::rejected-1')
    const c = seed('skill::rejected-2')
    setStatus(b.id, 'rejected')
    setStatus(c.id, 'rejected')

    const removed = clearByStatus('rejected')

    expect(removed).toBe(2)
    const remaining = readAll()
    expect(remaining.map(r => r.signature)).toEqual(['skill::pending-1'])
    void a
  })

  it('returns 0 and no-ops when nothing matches', () => {
    seed('skill::just-pending')
    const removed = clearByStatus('rejected')
    expect(removed).toBe(0)
    expect(readAll()).toHaveLength(1)
  })

  it('returns 0 on an empty store', () => {
    const removed = clearByStatus('pending')
    expect(removed).toBe(0)
  })

  it('preserves on-disk file integrity (subsequent reads return remaining candidates)', () => {
    const a = seed('skill::keeper')
    const b = seed('skill::doomed')
    setStatus(a.id, 'accepted', '/fake/keeper.md')
    expect(b).toBeDefined()

    clearByStatus('pending')

    // Re-read from disk by going through readAll (which re-parses the file).
    const after = readAll()
    expect(after).toHaveLength(1)
    expect(after[0].signature).toBe('skill::keeper')
    expect(after[0].status).toBe('accepted')
    expect(after[0].acceptedPath).toBe('/fake/keeper.md')
  })

  it('coexists with deleteById', () => {
    const a = seed('skill::one')
    seed('skill::two')
    seed('skill::three')
    deleteById(a.id)

    const removed = clearByStatus('pending')
    expect(removed).toBe(2)
    expect(readAll()).toEqual([])
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  createBundle,
  deleteBundle,
  getBundle,
  listBundles,
  setEnabled,
  slugify,
  updateBundle,
} from '../superRouter/store'

let tmp: string
let origHome: string | undefined

beforeEach(() => {
  origHome = process.env['HOME']
  tmp = fs.mkdtempSync(path.join(os.homedir(), '.lsm-srouter-store-'))
  process.env['HOME'] = tmp
})

afterEach(() => {
  process.env['HOME'] = origHome
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('slugify', () => {
  it('lowercases, dashes, strips junk', () => {
    expect(slugify('My Big Bundle!!')).toBe('my-big-bundle')
    expect(slugify('  ---  ')).toBe('bundle')
  })
})

describe('createBundle', () => {
  it('persists and returns a bundle with disabled=false', () => {
    const b = createBundle({
      name: 'Refactoring',
      target: 'claude',
      scope: { kind: 'global' },
      trigger: 'when refactoring',
      skills: [{id:'a'},{id:'b'}],
    })
    expect(b.id).toBeTruthy()
    expect(b.slug).toBe('refactoring')
    expect(b.enabled).toBe(false)
    const list = listBundles()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(b.id)
  })

  it('rejects duplicate name within the same scope+target', () => {
    createBundle({
      name: 'X',
      target: 'claude',
      scope: { kind: 'global' },
      trigger: 't',
      skills: [{id:'a'}],
    })
    expect(() =>
      createBundle({
        name: 'X',
        target: 'claude',
        scope: { kind: 'global' },
        trigger: 't',
        skills: [{id:'a'}],
      }),
    ).toThrow(/already exists/)
  })

  it('allows same name across different scopes', () => {
    createBundle({
      name: 'X',
      target: 'claude',
      scope: { kind: 'global' },
      trigger: 't',
      skills: [{id:'a'}],
    })
    expect(() =>
      createBundle({
        name: 'X',
        target: 'cursor',
        scope: { kind: 'global' },
        trigger: 't',
        skills: [{id:'a'}],
      }),
    ).not.toThrow()
  })

  it('disambiguates slugs when names collide across scopes', () => {
    const a = createBundle({
      name: 'X',
      target: 'claude',
      scope: { kind: 'global' },
      trigger: 't',
      skills: [{id:'a'}],
    })
    const b = createBundle({
      name: 'X',
      target: 'cursor',
      scope: { kind: 'global' },
      trigger: 't',
      skills: [{id:'a'}],
    })
    expect(a.slug).toBe('x')
    expect(b.slug).toBe('x-2')
  })
})

describe('updateBundle / setEnabled / deleteBundle', () => {
  it('updateBundle changes fields, preserves id and createdAt', () => {
    const created = createBundle({
      name: 'A',
      target: 'claude',
      scope: { kind: 'global' },
      trigger: 't',
      skills: [{id:'a'}],
    })
    const updated = updateBundle(created.id, {
      name: 'B',
      target: 'claude',
      scope: { kind: 'global' },
      trigger: 't2',
      skills: [{id:'a'},{id:'b'}],
    })
    expect(updated.id).toBe(created.id)
    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.name).toBe('B')
    expect(updated.slug).toBe('b')
    expect(updated.trigger).toBe('t2')
  })

  it('setEnabled flips the flag', () => {
    const b = createBundle({
      name: 'A',
      target: 'claude',
      scope: { kind: 'global' },
      trigger: 't',
      skills: [{id:'a'}],
    })
    expect(b.enabled).toBe(false)
    const enabled = setEnabled(b.id, true)
    expect(enabled.enabled).toBe(true)
    expect(getBundle(b.id)?.enabled).toBe(true)
  })

  it('deleteBundle removes it', () => {
    const b = createBundle({
      name: 'A',
      target: 'claude',
      scope: { kind: 'global' },
      trigger: 't',
      skills: [{id:'a'}],
    })
    deleteBundle(b.id)
    expect(getBundle(b.id)).toBeUndefined()
    expect(listBundles()).toHaveLength(0)
  })
})

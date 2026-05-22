import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { atomicWrite } from '../lib/atomicWrite'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-atomic-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('atomicWrite (LOC-42)', () => {
  it('writes the content to the target path', () => {
    const p = path.join(tmp, 'x.md')
    atomicWrite(p, 'hello')
    expect(fs.readFileSync(p, 'utf-8')).toBe('hello')
  })

  it('creates parent directories if missing', () => {
    const p = path.join(tmp, 'nested', 'sub', 'x.md')
    atomicWrite(p, 'hi')
    expect(fs.readFileSync(p, 'utf-8')).toBe('hi')
  })

  it('leaves no orphan tmp files on success', () => {
    const p = path.join(tmp, 'x.md')
    atomicWrite(p, 'one')
    atomicWrite(p, 'two')
    const orphans = fs.readdirSync(tmp).filter(n => n.includes('.tmp-'))
    expect(orphans).toEqual([])
    expect(fs.readFileSync(p, 'utf-8')).toBe('two')
  })

  it('cleans up the tmp file when the rename fails', () => {
    // Rename to a path inside a directory that doesn't exist after mkdirSync
    // succeeded for the parent — simulate by pointing at the parent's parent
    // which IS a file (not a dir). Easiest: pass a path with a non-dir
    // ancestor by writing a file then trying to atomicWrite into its child.
    const blocker = path.join(tmp, 'blocker')
    fs.writeFileSync(blocker, 'iamafile')
    const target = path.join(blocker, 'child.md')
    expect(() => atomicWrite(target, 'whatever')).toThrow()
    // No leftover tmp files in $tmp
    const orphans = fs.readdirSync(tmp).filter(n => n.includes('.tmp-'))
    expect(orphans).toEqual([])
  })

  it('accepts a Buffer payload', () => {
    const p = path.join(tmp, 'bin.md')
    atomicWrite(p, Buffer.from([0x68, 0x69]))
    expect(fs.readFileSync(p, 'utf-8')).toBe('hi')
  })
})

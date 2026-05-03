import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { computeHealth } from '../scanner/health'
import type { Skill } from '../scanner/types'

let tmp: string

function write(p: string, content: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
}

function base(overrides: Partial<Skill> = {}): Omit<Skill, 'health'> {
  return {
    id: 'test-id',
    name: 'my-skill',
    description: 'Does something useful',
    version: '',
    type: 'skill',
    scope: 'global',
    account: 'default',
    path: '/fake/path/SKILL.md',
    realpath: '/fake/path/SKILL.md',
    isSymlink: false,
    body: '',
    frontmatter: { 'allowed-tools': 'Bash,Read' },
    lastModified: new Date().toISOString(),
    ...overrides,
  }
}

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-health-')) })
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe('computeHealth', () => {
  it('returns ok for a fully valid skill', () => {
    const result = computeHealth(base())
    expect(result.status).toBe('ok')
    expect(result.issues).toHaveLength(0)
  })

  it('flags missing name as error', () => {
    const result = computeHealth(base({ name: '' }))
    expect(result.status).toBe('error')
    expect(result.issues.some(i => i.severity === 'error' && /name/i.test(i.message))).toBe(true)
  })

  it('flags missing description as warn', () => {
    const result = computeHealth(base({ description: '' }))
    expect(result.status).toBe('warn')
    expect(result.issues.some(i => /description/i.test(i.message))).toBe(true)
  })

  it('flags short description as warn', () => {
    const result = computeHealth(base({ description: 'Too short' }))
    expect(result.status).toBe('warn')
    expect(result.issues.some(i => /short/i.test(i.message))).toBe(true)
  })

  it('flags missing allowed-tools for skills as warn', () => {
    const result = computeHealth(base({ frontmatter: {} }))
    expect(result.status).toBe('warn')
    expect(result.issues.some(i => /allowed-tools/i.test(i.message))).toBe(true)
  })

  it('does not flag missing allowed-tools for commands', () => {
    const result = computeHealth(base({ type: 'command', frontmatter: {} }))
    expect(result.issues.every(i => !/allowed-tools/i.test(i.message))).toBe(true)
  })

  it('error takes precedence over warn in status', () => {
    const result = computeHealth(base({ name: '', description: '' }))
    expect(result.status).toBe('error')
  })

  it('flags broken symlinks as error', () => {
    const realFile = path.join(tmp, 'real.md')
    write(realFile, '# body')
    const linkFile = path.join(tmp, 'link.md')
    try {
      fs.symlinkSync(path.join(tmp, 'nonexistent.md'), linkFile)
    } catch {
      return // symlinks unsupported in this env
    }
    const result = computeHealth(base({
      path: linkFile,
      realpath: path.join(tmp, 'nonexistent.md'),
      isSymlink: true,
    }))
    expect(result.status).toBe('error')
    expect(result.issues.some(i => /symlink/i.test(i.message))).toBe(true)
  })
})

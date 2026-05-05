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
    description: 'Runs something useful every day',
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
    disabled: false,
    references: [],
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

  it('flags short description (< 10 chars) as warn with new message', () => {
    const result = computeHealth(base({ description: 'Too short' }))
    expect(result.status).toBe('warn')
    expect(result.issues.some(i => /too short/i.test(i.message))).toBe(true)
    expect(result.issues.some(i => /progressive disclosure/i.test(i.message))).toBe(true)
  })

  it('flags description < 20 chars (but >= 10) as warn with new message', () => {
    // "Short desc." is 11 chars — between 10 and 20
    const result = computeHealth(base({ description: 'Short desc.' }))
    expect(result.status).toBe('warn')
    expect(result.issues.some(i => /too short/i.test(i.message))).toBe(true)
    expect(result.issues.some(i => /progressive disclosure/i.test(i.message))).toBe(true)
  })

  it('flags missing allowed-tools for skills that use tools', () => {
    const result = computeHealth(base({ frontmatter: {}, body: 'Uses Bash to run commands' }))
    expect(result.status).toBe('warn')
    expect(result.issues.some(i => /allowed-tools/i.test(i.message))).toBe(true)
  })

  it('does not flag missing allowed-tools for documentation-only skills', () => {
    const result = computeHealth(base({ frontmatter: {}, body: 'A conceptual guide with no tool calls' }))
    expect(result.issues.every(i => !/allowed-tools/i.test(i.message))).toBe(true)
  })

  it('does not flag missing allowed-tools for commands', () => {
    const result = computeHealth(base({ type: 'command', frontmatter: {}, body: 'Uses Bash' }))
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

describe('computeHealth — description quality checks', () => {
  it('warns when description has no verb in first 10 words', () => {
    // >= 20 chars, no verb in the first 10 words
    const result = computeHealth(base({ description: 'A helpful utility for daily workflow automation' }))
    expect(result.issues.some(i => /action verb/i.test(i.message))).toBe(true)
  })

  it('does not warn about verb when description starts with a clear verb', () => {
    const result = computeHealth(base({ description: 'Generates a commit message for staged changes' }))
    expect(result.issues.every(i => !/action verb/i.test(i.message))).toBe(true)
  })

  it('does not warn about verb for a valid description with verb', () => {
    // base() description is "Does something useful here" — "Does" is not in COMMON_VERBS
    // Use a description that definitely has a verb
    const result = computeHealth(base({ description: 'Runs a health check on all installed skills' }))
    expect(result.issues.every(i => !/action verb/i.test(i.message))).toBe(true)
  })

  it('warns when descriptionCounts has count >= 2 for this skill', () => {
    const desc = 'Generates a commit message for staged changes'
    const descriptionCounts = new Map([[ desc.toLowerCase().trim(), 2 ]])
    const result = computeHealth(base({ description: desc }), { descriptionCounts })
    expect(result.issues.some(i => /identical to another skill/i.test(i.message))).toBe(true)
  })

  it('does not warn about duplicate when descriptionCounts has count 1', () => {
    const desc = 'Generates a commit message for staged changes'
    const descriptionCounts = new Map([[ desc.toLowerCase().trim(), 1 ]])
    const result = computeHealth(base({ description: desc }), { descriptionCounts })
    expect(result.issues.every(i => !/identical to another skill/i.test(i.message))).toBe(true)
  })
})

describe('scope mismatch detection', () => {
  it('warns global skill with /Users/ path in body', () => {
    const result = computeHealth(base({
      scope: 'global',
      body: 'Run this from /Users/robertso/Code/foo to build.',
      frontmatter: { 'allowed-tools': 'Bash' },
    }))
    expect(result.issues.some(i => /Global skill references project-specific path/.test(i.message) && /\/Users\/robertso\/Code\/foo/.test(i.message))).toBe(true)
  })

  it('warns global skill with .env reference in body', () => {
    const result = computeHealth(base({
      scope: 'global',
      body: 'Load variables from the .env file before running.',
      frontmatter: { 'allowed-tools': 'Bash' },
    }))
    expect(result.issues.some(i => /Global skill references \.env/.test(i.message))).toBe(true)
  })

  it('warns global skill with "this project" phrase in body', () => {
    const result = computeHealth(base({
      scope: 'global',
      body: 'Use this skill to manage this project dependencies.',
      frontmatter: { 'allowed-tools': 'Bash' },
    }))
    expect(result.issues.some(i => /Global skill contains project-specific phrase: "this project"/.test(i.message))).toBe(true)
  })

  it('does not warn global skill with no project-specific content', () => {
    const result = computeHealth(base({
      scope: 'global',
      body: 'Runs a build pipeline and outputs results.',
      frontmatter: { 'allowed-tools': 'Bash' },
    }))
    expect(result.issues.every(i => !/scope/i.test(i.message) && !/project-specific/.test(i.message) && !/generic phrasing/.test(i.message))).toBe(true)
  })

  it('warns project skill with "any codebase" and no anchors', () => {
    const result = computeHealth(base({
      scope: 'project',
      body: 'Works with any codebase to generate documentation.',
      frontmatter: { 'allowed-tools': 'Bash' },
    }))
    expect(result.issues.some(i => /Project skill uses generic phrasing \("any codebase"\)/.test(i.message))).toBe(true)
  })

  it('does not warn project skill with "any codebase" when "this project" anchor is present', () => {
    const result = computeHealth(base({
      scope: 'project',
      body: 'Works with any codebase but specifically for this project setup.',
      frontmatter: { 'allowed-tools': 'Bash' },
    }))
    expect(result.issues.every(i => !/generic phrasing/.test(i.message))).toBe(true)
  })
})

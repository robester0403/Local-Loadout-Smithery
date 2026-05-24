import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  emitRuleAppend,
  __test as ruleTest,
} from '../autoSkill/emitRule'
import { extractRuleMarkerIds } from '../autoSkill/signals/lib/ruleMarkers'

let homeDir: string
let realHomedir: () => string

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-rule-emit-'))
  // Patch os.homedir() so assertWithinHome (used elsewhere) accepts our tmp.
  realHomedir = os.homedir
  ;(os as { homedir: () => string }).homedir = () => homeDir
})

afterEach(() => {
  ;(os as { homedir: () => string }).homedir = realHomedir
  try { fs.rmSync(homeDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

function mkAccountDir(name: string): string {
  const dir = path.join(homeDir, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeFile(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

// ---- resolveRuleFile --------------------------------------------------------

describe('resolveRuleFile', () => {
  it('routes .claude → CLAUDE.md', () => {
    expect(ruleTest.resolveRuleFile(path.join(homeDir, '.claude'))).toBe(path.join(homeDir, '.claude', 'CLAUDE.md'))
  })

  it('routes .claude-foo → CLAUDE.md (multi-account variant)', () => {
    expect(ruleTest.resolveRuleFile(path.join(homeDir, '.claude-work'))).toBe(path.join(homeDir, '.claude-work', 'CLAUDE.md'))
  })

  it('routes .cursor → AGENTS.md', () => {
    expect(ruleTest.resolveRuleFile(path.join(homeDir, '.cursor'))).toBe(path.join(homeDir, '.cursor', 'AGENTS.md'))
  })

  it('routes .codex → AGENTS.md', () => {
    expect(ruleTest.resolveRuleFile(path.join(homeDir, '.codex'))).toBe(path.join(homeDir, '.codex', 'AGENTS.md'))
  })
})

// ---- appendRuleBlock --------------------------------------------------------

describe('appendRuleBlock', () => {
  it('creates the section when missing and appends the block', () => {
    const out = ruleTest.appendRuleBlock('', 'Conventions', 'Always X.', 'abc123')
    expect(out).toMatch(/^## Conventions/m)
    expect(out).toContain('<!-- LS-rule:abc123 start -->')
    expect(out).toContain('Always X.')
    expect(out).toContain('<!-- LS-rule:abc123 end -->')
  })

  it('appends inside an existing section, before the next H2', () => {
    const body = [
      '# Heading',
      '',
      '## Conventions',
      '',
      'Existing convention.',
      '',
      '## Other',
      '',
      'Other content.',
      '',
    ].join('\n')
    const out = ruleTest.appendRuleBlock(body, 'Conventions', 'New rule.', 'def456')
    const convIdx = out.indexOf('## Conventions')
    const otherIdx = out.indexOf('## Other')
    const ruleIdx = out.indexOf('New rule.')
    expect(ruleIdx).toBeGreaterThan(convIdx)
    expect(ruleIdx).toBeLessThan(otherIdx)
    expect(out).toContain('Existing convention.') // didn't drop existing
  })

  it('section match is case-insensitive', () => {
    const body = '# H\n\n## conventions\n\nfoo\n'
    const out = ruleTest.appendRuleBlock(body, 'Conventions', 'X', 'xxx')
    // Should reuse the lowercase section, not create a new one.
    expect((out.match(/## conventions/gi) ?? []).length).toBe(1)
    expect(out).toContain('X')
  })
})

// ---- emitRuleAppend end-to-end ---------------------------------------------

describe('emitRuleAppend', () => {
  it('writes CLAUDE.md when none exists, wrapped in markers', () => {
    const acct = mkAccountDir('.claude')
    const result = emitRuleAppend({
      accountDir: acct,
      ruleText: 'Always use TypeScript',
      suggestedSection: 'Conventions',
    })
    expect(result.appended).toBe(true)
    expect(result.path).toBe(path.join(acct, 'CLAUDE.md'))
    const written = fs.readFileSync(result.path, 'utf-8')
    expect(written).toContain('## Conventions')
    expect(written).toContain('<!-- LS-rule:')
    expect(written).toContain('Always use TypeScript')
    const ids = extractRuleMarkerIds(written)
    expect(ids.has(result.markerId)).toBe(true)
  })

  it('appends to existing CLAUDE.md without clobbering content', () => {
    const acct = mkAccountDir('.claude')
    const file = path.join(acct, 'CLAUDE.md')
    writeFile(file, '# Existing\n\n## Tooling\n\nUse Prettier.\n')
    emitRuleAppend({ accountDir: acct, ruleText: 'Always use TypeScript', suggestedSection: 'Conventions' })
    const written = fs.readFileSync(file, 'utf-8')
    expect(written).toContain('# Existing')
    expect(written).toContain('Use Prettier.') // didn't get clobbered
    expect(written).toContain('## Conventions')
    expect(written).toContain('Always use TypeScript')
  })

  it('idempotent: re-accepting same rule yields appended=false and no duplicate', () => {
    const acct = mkAccountDir('.claude')
    const opts = { accountDir: acct, ruleText: 'Always use TypeScript', suggestedSection: 'Conventions' }
    const first = emitRuleAppend(opts)
    const second = emitRuleAppend(opts)
    expect(first.appended).toBe(true)
    expect(second.appended).toBe(false)
    expect(first.markerId).toBe(second.markerId)
    const written = fs.readFileSync(first.path, 'utf-8')
    // Exactly one occurrence of the rule text.
    expect((written.match(/Always use TypeScript/g) ?? []).length).toBe(1)
  })

  it('different suggestedSection produces a different marker id', () => {
    const acct = mkAccountDir('.claude')
    const a = emitRuleAppend({ accountDir: acct, ruleText: 'Always X', suggestedSection: 'Conventions' })
    const b = emitRuleAppend({ accountDir: acct, ruleText: 'Always X', suggestedSection: 'Tooling' })
    expect(a.markerId).not.toBe(b.markerId)
  })

  it('AGENTS.md is the destination for .cursor', () => {
    const acct = mkAccountDir('.cursor')
    const r = emitRuleAppend({ accountDir: acct, ruleText: 'Always cursor', suggestedSection: 'Conventions' })
    expect(r.path).toBe(path.join(acct, 'AGENTS.md'))
    expect(fs.readFileSync(r.path, 'utf-8')).toContain('Always cursor')
  })

  it('AGENTS.md is the destination for .codex', () => {
    const acct = mkAccountDir('.codex')
    const r = emitRuleAppend({ accountDir: acct, ruleText: 'Always codex', suggestedSection: 'Conventions' })
    expect(r.path).toBe(path.join(acct, 'AGENTS.md'))
  })

  it('falls back to default section "Conventions" when none provided', () => {
    const acct = mkAccountDir('.claude')
    const r = emitRuleAppend({ accountDir: acct, ruleText: 'No section' })
    expect(r.appended).toBe(true)
    expect(fs.readFileSync(r.path, 'utf-8')).toContain('## Conventions')
  })

  it('throws on empty ruleText', () => {
    const acct = mkAccountDir('.claude')
    expect(() => emitRuleAppend({ accountDir: acct, ruleText: '   ', suggestedSection: 'X' })).toThrow(/empty/)
  })
})

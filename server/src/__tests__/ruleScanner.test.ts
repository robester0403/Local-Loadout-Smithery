import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  parseRulesFromBody,
  parseRulesFromFile,
  scanRuleArtifacts,
  ruleArtifactToSkill,
  ruleLogicalPath,
  isRuleLogicalPath,
  parseRuleLogicalPath,
  exciseRuleBlock,
  defaultRuleTargets,
} from '../scanner/ruleScanner'
import {
  ruleMarkerStart,
  ruleMarkerEnd,
  computeRuleMarkerId,
} from '../autoSkill/signals/lib/ruleMarkers'

function ruleBlock(id: string, body: string): string {
  return [ruleMarkerStart(id), body, ruleMarkerEnd(id)].join('\n')
}

describe('parseRulesFromBody', () => {
  it('extracts a single marker block with surrounding section', () => {
    const body = [
      '# CLAUDE.md',
      '',
      '## Conventions',
      '',
      'Some preamble.',
      '',
      ruleBlock('abc123', 'Always prefer rebase over merge.'),
      '',
      '## Other',
    ].join('\n')

    const out = parseRulesFromBody(body, { file: '/x/CLAUDE.md', source: 'claude', account: 'default' })
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('abc123')
    expect(out[0].section).toBe('Conventions')
    expect(out[0].ruleText).toBe('Always prefer rebase over merge.')
    expect(out[0].source).toBe('claude')
    expect(out[0].account).toBe('default')
    expect(out[0].file).toBe('/x/CLAUDE.md')
    expect(out[0].lineStart).toBeGreaterThan(0)
    expect(out[0].lineEnd).toBeGreaterThan(out[0].lineStart)
  })

  it('extracts multiple markers from the same file', () => {
    const body = [
      '## Section A',
      ruleBlock('aaa', 'Rule A body.'),
      '',
      '## Section B',
      ruleBlock('bbb', 'Rule B body.'),
    ].join('\n')

    const out = parseRulesFromBody(body, { file: '/x/F.md', source: 'cursor', account: 'cursor' })
    expect(out.map(r => r.id)).toEqual(['aaa', 'bbb'])
    expect(out[0].section).toBe('Section A')
    expect(out[1].section).toBe('Section B')
  })

  it('returns empty list for body with no markers', () => {
    const body = '# CLAUDE.md\n\n## Conventions\n\nNo markers here.\n'
    expect(parseRulesFromBody(body, { file: '/x/F.md', source: 'claude', account: 'default' })).toEqual([])
  })

  it('returns empty list for empty body', () => {
    expect(parseRulesFromBody('', { file: '/x/F.md', source: 'claude', account: 'default' })).toEqual([])
  })

  it('tolerates malformed (unterminated) markers — silently drops', () => {
    const body = [
      '## Conventions',
      ruleMarkerStart('abc'),
      'no end marker here',
    ].join('\n')
    expect(parseRulesFromBody(body, { file: '/x/F.md', source: 'claude', account: 'default' })).toEqual([])
  })

  it('handles multi-line rule bodies', () => {
    const body = [
      '## C',
      ruleMarkerStart('multi'),
      'Line 1.',
      'Line 2.',
      '- bullet',
      ruleMarkerEnd('multi'),
    ].join('\n')
    const out = parseRulesFromBody(body, { file: '/x/F.md', source: 'claude', account: 'default' })
    expect(out).toHaveLength(1)
    expect(out[0].ruleText).toBe('Line 1.\nLine 2.\n- bullet')
  })

  it('empty section when marker appears before any heading', () => {
    const body = [
      ruleMarkerStart('top'),
      'rule before any heading',
      ruleMarkerEnd('top'),
    ].join('\n')
    const out = parseRulesFromBody(body, { file: '/x/F.md', source: 'claude', account: 'default' })
    expect(out[0].section).toBe('')
  })
})

describe('parseRulesFromFile', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ruleScanner-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('returns [] for a missing file', () => {
    const out = parseRulesFromFile({ file: path.join(tmp, 'nope.md'), source: 'claude', account: 'default' })
    expect(out).toEqual([])
  })

  it('parses an actual file end-to-end', () => {
    const id = computeRuleMarkerId('Use tabs.', 'Conventions')
    const file = path.join(tmp, 'CLAUDE.md')
    fs.writeFileSync(file, ['## Conventions', '', ruleBlock(id, 'Use tabs.'), ''].join('\n'))
    const out = parseRulesFromFile({ file, source: 'claude', account: 'default' })
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe(id)
  })
})

describe('scanRuleArtifacts (parity across ecosystems)', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ruleScannerParity-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('scans claude / cursor / codex files in one pass', () => {
    const claudeFile = path.join(tmp, 'CLAUDE.md')
    const cursorFile = path.join(tmp, 'AGENTS-cursor.md')
    const codexFile = path.join(tmp, 'AGENTS-codex.md')
    fs.writeFileSync(claudeFile, ruleBlock('c1', 'claude rule'))
    fs.writeFileSync(cursorFile, ruleBlock('c2', 'cursor rule'))
    fs.writeFileSync(codexFile, ruleBlock('c3', 'codex rule'))

    const out = scanRuleArtifacts([
      { file: claudeFile, source: 'claude', account: 'default' },
      { file: cursorFile, source: 'cursor', account: 'cursor' },
      { file: codexFile, source: 'codex', account: 'codex' },
    ])

    expect(out.map(r => r.source).sort()).toEqual(['claude', 'codex', 'cursor'])
    expect(out.find(r => r.source === 'claude')?.id).toBe('c1')
    expect(out.find(r => r.source === 'cursor')?.id).toBe('c2')
    expect(out.find(r => r.source === 'codex')?.id).toBe('c3')
  })

  it('missing ecosystem files are skipped silently', () => {
    const file = path.join(tmp, 'CLAUDE.md')
    fs.writeFileSync(file, ruleBlock('only', 'only one ecosystem'))
    const out = scanRuleArtifacts([
      { file, source: 'claude', account: 'default' },
      { file: path.join(tmp, 'no-cursor.md'), source: 'cursor', account: 'cursor' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('only')
  })
})

describe('defaultRuleTargets', () => {
  it('maps default account → ~/.claude/CLAUDE.md', () => {
    const out = defaultRuleTargets(['default'], '/h')
    expect(out).toEqual([{ file: '/h/.claude/CLAUDE.md', source: 'claude', account: 'default' }])
  })

  it('maps cursor → ~/.cursor/AGENTS.md and codex → ~/.codex/AGENTS.md', () => {
    const out = defaultRuleTargets(['cursor', 'codex'], '/h')
    expect(out).toContainEqual({ file: '/h/.cursor/AGENTS.md', source: 'cursor', account: 'cursor' })
    expect(out).toContainEqual({ file: '/h/.codex/AGENTS.md', source: 'codex', account: 'codex' })
  })

  it('maps additional Claude accounts to .claude-<label>/CLAUDE.md', () => {
    const out = defaultRuleTargets(['work'], '/h')
    expect(out).toEqual([{ file: '/h/.claude-work/CLAUDE.md', source: 'claude', account: 'work' }])
  })
})

describe('ruleArtifactToSkill', () => {
  it('produces a Skill row with type=rule and a base64-encoded id', () => {
    const artifact = {
      id: 'sha16',
      source: 'claude' as const,
      file: '/Users/x/.claude/CLAUDE.md',
      account: 'default',
      section: 'Conventions',
      ruleText: 'First line of the rule.\nSecond line of detail.',
      lineStart: 10,
      lineEnd: 14,
    }
    const skill = ruleArtifactToSkill(artifact)
    expect(skill.type).toBe('rule')
    expect(skill.scope).toBe('global')
    expect(skill.account).toBe('default')
    expect(skill.body).toBe(artifact.ruleText)
    expect(skill.name).toBe('First line of the rule.')
    expect(skill.description).toContain('Conventions')
    expect(skill.description).toContain('CLAUDE.md')
    // ID round-trip
    const decoded = Buffer.from(skill.id, 'base64').toString('utf-8')
    expect(decoded).toContain('#LS-rule:sha16')
    expect(skill.frontmatter['ls-rule-id']).toBe('sha16')
    expect(skill.health.status).toBe('ok')
    expect(skill.health.issues).toEqual([])
  })
})

describe('id-encoding helpers', () => {
  it('round-trips through ruleLogicalPath / parseRuleLogicalPath', () => {
    const p = ruleLogicalPath('/Users/x/.claude/CLAUDE.md', 'abc123')
    expect(isRuleLogicalPath(p)).toBe(true)
    const parsed = parseRuleLogicalPath(p)
    expect(parsed).toEqual({ file: '/Users/x/.claude/CLAUDE.md', markerId: 'abc123' })
  })

  it('returns null for a non-rule path', () => {
    expect(isRuleLogicalPath('/Users/x/.claude/skills/foo/SKILL.md')).toBe(false)
    expect(parseRuleLogicalPath('/Users/x/.claude/skills/foo/SKILL.md')).toBeNull()
  })
})

describe('exciseRuleBlock', () => {
  it('excises only the target marker, leaving siblings intact', () => {
    const body = [
      '## Conventions',
      '',
      ruleBlock('keep1', 'keep me'),
      '',
      ruleBlock('cut', 'remove me'),
      '',
      ruleBlock('keep2', 'keep me too'),
      '',
    ].join('\n')

    const next = exciseRuleBlock(body, 'cut')
    expect(next).not.toBeNull()
    expect(next).toContain('keep1')
    expect(next).toContain('keep2')
    expect(next).not.toContain('cut')
    expect(next).not.toContain('remove me')
  })

  it('returns null when marker not present (idempotent signal)', () => {
    const body = '## Conventions\n\n' + ruleBlock('a', 'x') + '\n'
    expect(exciseRuleBlock(body, 'missing')).toBeNull()
  })

  it('does not leave triple-blank runs where the block used to be', () => {
    const body = [
      '## A',
      '',
      'Preface.',
      '',
      ruleBlock('cut', 'gone'),
      '',
      'Postface.',
      '',
    ].join('\n')
    const next = exciseRuleBlock(body, 'cut')
    expect(next).not.toMatch(/\n\n\n\n/)
    expect(next).toContain('Preface.')
    expect(next).toContain('Postface.')
  })

  it('cleans excess trailing blank lines when block was the last content', () => {
    const body = '## A\n\n' + ruleBlock('cut', 'gone') + '\n\n\n'
    const next = exciseRuleBlock(body, 'cut')
    // Single trailing newline is fine (POSIX file convention); just ensure
    // we didn't leave a multi-blank trailing run.
    expect(next).not.toMatch(/\n\n\n$/)
    expect(next?.trimEnd()).toBe('## A')
  })
})

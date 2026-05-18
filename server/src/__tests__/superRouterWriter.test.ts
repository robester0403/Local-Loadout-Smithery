import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { applyBundle, removeBundle, __test, type ResolvedSkillRow } from '../superRouter/writer'
import type { Bundle } from '../superRouter/types'
import type { Skill } from '../scanner/types'

let tmp: string

function bundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    id: 'bundle-123',
    name: 'Refactoring',
    slug: 'refactoring',
    target: 'claude',
    scope: { kind: 'global' },
    trigger: 'When the user wants to refactor existing code.',
    skills: [],
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function skill(name: string, description: string, opts: Partial<Skill> = {}): Skill {
  return {
    id: Buffer.from(`/${name}`).toString('base64'),
    name,
    description,
    version: '1.0.0',
    type: 'skill',
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
    ...opts,
  }
}

function row(s: Skill, override?: string): ResolvedSkillRow {
  return { entry: { id: s.id, description: override }, skill: s }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.homedir(), '.lsm-srouter-test-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('renderTriggerBlock', () => {
  it('produces a block bracketed by start/end markers', () => {
    const b = bundle()
    const out = __test.renderTriggerBlock(b, './super-router/refactoring.md')
    expect(out.startsWith(__test.startMarker(b.id))).toBe(true)
    expect(out.endsWith(__test.endMarker(b.id))).toBe(true)
    expect(out).toContain('Skill group: Refactoring')
    expect(out).toContain('./super-router/refactoring.md')
    expect(out).toContain('When the user wants to refactor')
  })
})

describe('renderMapFile', () => {
  it('lists every skill with description, type, scope, path', () => {
    const out = __test.renderMapFile(bundle(), [
      row(skill('simplify', 'Review changed code.')),
      row(skill('skill-refiner', 'Refines existing skills.')),
    ])
    expect(out).toContain('# Skill map: Refactoring')
    expect(out).toContain('## simplify')
    expect(out).toContain('Review changed code.')
    expect(out).toContain('## skill-refiner')
    expect(out).toContain('Refines existing skills.')
  })

  it('handles empty list', () => {
    expect(__test.renderMapFile(bundle(), [])).toContain('No skills currently associated')
  })

  it('uses the per-bundle description override when present', () => {
    const out = __test.renderMapFile(bundle(), [
      row(skill('s', 'SOURCE TEXT'), 'BUNDLE OVERRIDE TEXT'),
    ])
    expect(out).toContain('BUNDLE OVERRIDE TEXT')
    expect(out).not.toContain('SOURCE TEXT')
  })

  it('shows the slash invocation in command headings', () => {
    const cmd = skill('cel-iterate', 'When iterating on integrations.', { type: 'command' })
    const out = __test.renderMapFile(bundle(), [row(cmd)])
    expect(out).toContain('## cel-iterate  (`/cel-iterate`)')
  })
})

describe('stripBlock', () => {
  it('removes only the block matching the id', () => {
    const id = 'abc'
    const otherId = 'xyz'
    const content = [
      'preamble', '',
      `<!-- super-router:${id} start -->`,
      'remove me',
      `<!-- super-router:${id} end -->`,
      '',
      `<!-- super-router:${otherId} start -->`,
      'keep me',
      `<!-- super-router:${otherId} end -->`,
      '',
      'epilogue',
    ].join('\n')
    const stripped = __test.stripBlock(content, id)
    expect(stripped).not.toContain('remove me')
    expect(stripped).toContain('keep me')
    expect(stripped).toContain('preamble')
    expect(stripped).toContain('epilogue')
  })

  it('is a no-op when the block is absent', () => {
    const content = '# Title\n\nbody\n'
    expect(__test.stripBlock(content, 'missing')).toBe(content)
  })
})

describe('applyBundle (global Claude)', () => {
  it('creates CLAUDE.md and map file on first apply', () => {
    const origHome = process.env['HOME']
    process.env['HOME'] = tmp
    try {
      const b = bundle()
      const result = applyBundle(b, [row(skill('simplify', 'desc'))])
      expect(fs.existsSync(result.topFile)).toBe(true)
      expect(fs.existsSync(result.mapFile)).toBe(true)
      const md = fs.readFileSync(result.topFile, 'utf-8')
      expect(md).toContain(__test.startMarker(b.id))
      expect(md).toContain(__test.endMarker(b.id))
      const map = fs.readFileSync(result.mapFile, 'utf-8')
      expect(map).toContain('## simplify')
    } finally {
      process.env['HOME'] = origHome
    }
  })

  it('replaces an existing block keyed by the same id rather than duplicating', () => {
    const origHome = process.env['HOME']
    process.env['HOME'] = tmp
    try {
      const b = bundle()
      applyBundle(b, [row(skill('first', 'old'))])
      applyBundle({ ...b, trigger: 'NEW TRIGGER' }, [row(skill('second', 'new'))])
      const md = fs.readFileSync(path.join(tmp, '.claude', 'CLAUDE.md'), 'utf-8')
      const occurrences = md.split(__test.startMarker(b.id)).length - 1
      expect(occurrences).toBe(1)
      expect(md).toContain('NEW TRIGGER')
      const map = fs.readFileSync(
        path.join(tmp, '.claude', 'super-router', `${b.slug}.md`),
        'utf-8',
      )
      expect(map).toContain('## second')
      expect(map).not.toContain('## first')
    } finally {
      process.env['HOME'] = origHome
    }
  })

  it('preserves preexisting content in CLAUDE.md when applying', () => {
    const origHome = process.env['HOME']
    process.env['HOME'] = tmp
    try {
      const claudeMd = path.join(tmp, '.claude', 'CLAUDE.md')
      fs.mkdirSync(path.dirname(claudeMd), { recursive: true })
      fs.writeFileSync(claudeMd, '# My instructions\n\nDo the thing.\n')
      applyBundle(bundle(), [])
      const md = fs.readFileSync(claudeMd, 'utf-8')
      expect(md).toContain('# My instructions')
      expect(md).toContain('Do the thing.')
      expect(md).toContain('super-router:bundle-123 start')
    } finally {
      process.env['HOME'] = origHome
    }
  })
})

describe('removeBundle', () => {
  it('strips the block and deletes the map file, leaves other CLAUDE.md content intact', () => {
    const origHome = process.env['HOME']
    process.env['HOME'] = tmp
    try {
      const claudeMd = path.join(tmp, '.claude', 'CLAUDE.md')
      fs.mkdirSync(path.dirname(claudeMd), { recursive: true })
      fs.writeFileSync(claudeMd, '# Keep me\n')
      const b = bundle()
      applyBundle(b, [row(skill('s', 'd'))])
      removeBundle(b)
      const md = fs.readFileSync(claudeMd, 'utf-8')
      expect(md).toContain('# Keep me')
      expect(md).not.toContain('super-router:bundle-123')
      expect(fs.existsSync(path.join(tmp, '.claude', 'super-router', `${b.slug}.md`))).toBe(false)
    } finally {
      process.env['HOME'] = origHome
    }
  })

  it('is idempotent when the bundle was never applied', () => {
    const origHome = process.env['HOME']
    process.env['HOME'] = tmp
    try {
      expect(() => removeBundle(bundle())).not.toThrow()
    } finally {
      process.env['HOME'] = origHome
    }
  })
})

describe('applyBundle (project Claude)', () => {
  it('writes to <project>/CLAUDE.md and <project>/.claude/super-router/<slug>.md', () => {
    const project = path.join(tmp, 'my-project')
    fs.mkdirSync(project, { recursive: true })
    const b = bundle({ scope: { kind: 'project', path: project } })
    const result = applyBundle(b, [])
    expect(result.topFile).toBe(path.join(project, 'CLAUDE.md'))
    expect(result.mapFile).toBe(path.join(project, '.claude', 'super-router', `${b.slug}.md`))
    expect(fs.existsSync(result.topFile)).toBe(true)
    expect(fs.existsSync(result.mapFile)).toBe(true)
  })
})

describe('applyBundle (Cursor target)', () => {
  it('global Cursor writes to ~/.cursor/CLAUDE.md and ~/.cursor/super-router/<slug>.md', () => {
    const origHome = process.env['HOME']
    process.env['HOME'] = tmp
    try {
      const b = bundle({ target: 'cursor' })
      const result = applyBundle(b, [row(skill('foo', 'd'))])
      expect(result.topFile).toBe(path.join(tmp, '.cursor', 'CLAUDE.md'))
      expect(result.mapFile).toBe(path.join(tmp, '.cursor', 'super-router', `${b.slug}.md`))
      expect(fs.existsSync(result.topFile)).toBe(true)
      const md = fs.readFileSync(result.topFile, 'utf-8')
      expect(md).toContain('./super-router/refactoring.md')
    } finally {
      process.env['HOME'] = origHome
    }
  })

  it('project Cursor writes to <project>/CLAUDE.md and <project>/.cursor/super-router/<slug>.md', () => {
    const project = path.join(tmp, 'my-project')
    fs.mkdirSync(project, { recursive: true })
    const b = bundle({ target: 'cursor', scope: { kind: 'project', path: project } })
    const result = applyBundle(b, [])
    expect(result.topFile).toBe(path.join(project, 'CLAUDE.md'))
    expect(result.mapFile).toBe(path.join(project, '.cursor', 'super-router', `${b.slug}.md`))
    const md = fs.readFileSync(result.topFile, 'utf-8')
    expect(md).toContain('./.cursor/super-router/refactoring.md')
  })

  it('Claude and Cursor bundles coexist in the same CLAUDE.md as distinct blocks', () => {
    const project = path.join(tmp, 'p')
    fs.mkdirSync(project, { recursive: true })
    const claudeB = bundle({
      id: 'claude-1', slug: 'claude-1', target: 'claude',
      scope: { kind: 'project', path: project }, name: 'C',
    })
    const cursorB = bundle({
      id: 'cursor-1', slug: 'cursor-1', target: 'cursor',
      scope: { kind: 'project', path: project }, name: 'X',
    })
    applyBundle(claudeB, [])
    applyBundle(cursorB, [])
    const md = fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf-8')
    expect(md).toContain('super-router:claude-1 start')
    expect(md).toContain('super-router:cursor-1 start')
    removeBundle(cursorB)
    const md2 = fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf-8')
    expect(md2).toContain('super-router:claude-1 start')
    expect(md2).not.toContain('super-router:cursor-1')
  })
})

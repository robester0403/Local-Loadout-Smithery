import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { applyBundle, type ResolvedSkillRow } from '../superRouter/writer'
import { detectDrift } from '../superRouter/drift'
import type { Bundle } from '../superRouter/types'
import type { Skill } from '../scanner/types'

let tmp: string
let origHome: string | undefined

function bundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    id: 'bundle-abc',
    name: 'Refactoring',
    slug: 'refactoring',
    target: 'claude',
    scope: { kind: 'global' },
    trigger: 'When refactoring existing code.',
    skills: [{ id: 'sk-1', description: 'desc 1' }],
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function skill(id: string, name: string): Skill {
  return {
    id,
    name,
    description: `desc for ${name}`,
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
  }
}

function rowsFor(b: Bundle): ResolvedSkillRow[] {
  return b.skills.map(entry => ({
    entry,
    skill: skill(entry.id, entry.id.replace(/[^a-z0-9]/gi, '-')),
  }))
}

beforeEach(() => {
  origHome = process.env['HOME']
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-drift-test-'))
  process.env['HOME'] = tmp
})
afterEach(() => {
  process.env['HOME'] = origHome
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('detectDrift', () => {
  it('reports ok when block and map match canonical content', () => {
    const b = bundle()
    const rows = rowsFor(b)
    applyBundle(b, rows)
    expect(detectDrift(b, rows).status).toBe('ok')
  })

  it('reports file-missing when CLAUDE.md does not exist', () => {
    const b = bundle()
    // no apply
    const result = detectDrift(b, rowsFor(b))
    expect(result.status).toBe('file-missing')
  })

  it('reports block-missing when CLAUDE.md exists but the block was removed', () => {
    const b = bundle()
    const claudeMd = path.join(tmp, '.claude', 'CLAUDE.md')
    fs.mkdirSync(path.dirname(claudeMd), { recursive: true })
    fs.writeFileSync(claudeMd, '# Just user content, no block\n')
    expect(detectDrift(b, rowsFor(b)).status).toBe('block-missing')
  })

  it('reports markers-corrupted when only the start marker is present', () => {
    const b = bundle()
    const claudeMd = path.join(tmp, '.claude', 'CLAUDE.md')
    fs.mkdirSync(path.dirname(claudeMd), { recursive: true })
    fs.writeFileSync(
      claudeMd,
      `# Prelude\n\n<!-- super-router:${b.id} start -->\n## Skill group\nsomething\n`,
    )
    const r = detectDrift(b, rowsFor(b))
    expect(r.status).toBe('markers-corrupted')
    expect(r.details).toMatch(/end marker missing/i)
  })

  it('reports markers-corrupted when only the end marker is present', () => {
    const b = bundle()
    const claudeMd = path.join(tmp, '.claude', 'CLAUDE.md')
    fs.mkdirSync(path.dirname(claudeMd), { recursive: true })
    fs.writeFileSync(
      claudeMd,
      `# Prelude\n\nsomething\n<!-- super-router:${b.id} end -->\n`,
    )
    const r = detectDrift(b, rowsFor(b))
    expect(r.status).toBe('markers-corrupted')
    expect(r.details).toMatch(/start marker missing/i)
  })

  it('reports block-modified when text inside the markers changed', () => {
    const b = bundle()
    const rows = rowsFor(b)
    applyBundle(b, rows)
    const claudeMd = path.join(tmp, '.claude', 'CLAUDE.md')
    const original = fs.readFileSync(claudeMd, 'utf-8')
    fs.writeFileSync(
      claudeMd,
      original.replace('When refactoring existing code.', 'HAND-EDITED'),
    )
    expect(detectDrift(b, rows).status).toBe('block-modified')
  })

  it('reports map-modified when the trigger block is intact but the map file was edited', () => {
    const b = bundle()
    const rows = rowsFor(b)
    applyBundle(b, rows)
    const mapFile = path.join(tmp, '.claude', 'super-router', `${b.slug}.md`)
    fs.appendFileSync(mapFile, '\nUSER ADDED THIS\n')
    expect(detectDrift(b, rows).status).toBe('map-modified')
  })

  it('reports map-modified when the map file has been deleted', () => {
    const b = bundle()
    const rows = rowsFor(b)
    applyBundle(b, rows)
    const mapFile = path.join(tmp, '.claude', 'super-router', `${b.slug}.md`)
    fs.unlinkSync(mapFile)
    const r = detectDrift(b, rows)
    expect(r.status).toBe('map-modified')
    expect(r.details).toMatch(/missing/i)
  })

  it('detects drift for Cursor-target bundles (global)', () => {
    const b = bundle({ target: 'cursor', slug: 'cursor-bundle' })
    const rows = rowsFor(b)
    applyBundle(b, rows)
    expect(detectDrift(b, rows).status).toBe('ok')

    const cursorMd = path.join(tmp, '.cursor', 'CLAUDE.md')
    const original = fs.readFileSync(cursorMd, 'utf-8')
    fs.writeFileSync(cursorMd, original.replace('When refactoring existing code.', 'TAMPERED'))
    expect(detectDrift(b, rows).status).toBe('block-modified')
  })

  it('detects drift for Cursor-target bundles (project scope)', () => {
    const project = path.join(tmp, 'my-cursor-project')
    fs.mkdirSync(project, { recursive: true })
    const b = bundle({
      id: 'cursor-proj',
      slug: 'cursor-proj',
      target: 'cursor',
      scope: { kind: 'project', path: project },
    })
    const rows = rowsFor(b)
    applyBundle(b, rows)
    fs.appendFileSync(
      path.join(project, '.cursor', 'super-router', `${b.slug}.md`),
      '\nUSER EDITED\n',
    )
    expect(detectDrift(b, rows).status).toBe('map-modified')
  })

  it('treats Claude and Cursor bundles in the same CLAUDE.md as independent', () => {
    const project = path.join(tmp, 'p2')
    fs.mkdirSync(project, { recursive: true })
    const claudeB = bundle({
      id: 'claude-side', slug: 'claude-side', target: 'claude',
      scope: { kind: 'project', path: project }, name: 'Claude side',
    })
    const cursorB = bundle({
      id: 'cursor-side', slug: 'cursor-side', target: 'cursor',
      scope: { kind: 'project', path: project }, name: 'Cursor side',
    })
    const rowsClaude = rowsFor(claudeB)
    const rowsCursor = rowsFor(cursorB)
    applyBundle(claudeB, rowsClaude)
    applyBundle(cursorB, rowsCursor)

    const md = fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf-8')
    const re = new RegExp(`<!-- super-router:cursor-side start -->[\\s\\S]*?<!-- super-router:cursor-side end -->`)
    fs.writeFileSync(
      path.join(project, 'CLAUDE.md'),
      md.replace(re, '<!-- super-router:cursor-side start -->\nTAMPERED\n<!-- super-router:cursor-side end -->'),
    )
    expect(detectDrift(claudeB, rowsClaude).status).toBe('ok')
    expect(detectDrift(cursorB, rowsCursor).status).toBe('block-modified')
  })

  it('distinguishes drift per-bundle when two bundles share CLAUDE.md', () => {
    const project = path.join(tmp, 'p')
    fs.mkdirSync(project, { recursive: true })
    const a = bundle({
      id: 'a', slug: 'a', name: 'A',
      scope: { kind: 'project', path: project },
    })
    const c = bundle({
      id: 'c', slug: 'c', name: 'C',
      scope: { kind: 'project', path: project },
    })
    const rowsA = rowsFor(a)
    const rowsC = rowsFor(c)
    applyBundle(a, rowsA)
    applyBundle(c, rowsC)

    // Hand-edit only bundle c's block.
    const claudeMd = path.join(project, 'CLAUDE.md')
    const md = fs.readFileSync(claudeMd, 'utf-8')
    const re = new RegExp(`<!-- super-router:c start -->[\\s\\S]*?<!-- super-router:c end -->`)
    fs.writeFileSync(
      claudeMd,
      md.replace(re, '<!-- super-router:c start -->\nBROKEN\n<!-- super-router:c end -->'),
    )

    expect(detectDrift(a, rowsA).status).toBe('ok')
    expect(detectDrift(c, rowsC).status).toBe('block-modified')
  })
})

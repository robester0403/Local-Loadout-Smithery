import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FrontmatterWriteError, updateSkillFile } from '../parser/frontmatterWriter'
import { parseFrontmatter } from '../parser/frontmatter'

let tmp: string
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-fw-')) })
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

let fp: string
beforeEach(() => { fp = path.join(tmp, `s-${Math.random().toString(36).slice(2)}.md`) })

function write(content: string) { fs.writeFileSync(fp, content, 'utf-8') }

describe('updateSkillFile — description', () => {
  it('replaces an existing description line in-place', () => {
    write(`---\nname: foo\ndescription: old\nversion: 1\n---\nBody here.\n`)
    updateSkillFile(fp, { description: 'new desc' })
    const { meta, body } = parseFrontmatter(fp)
    expect(meta.description).toBe('new desc')
    expect(meta.name).toBe('foo')
    expect(meta.version).toBe('1')  // parser returns scalars as strings
    expect(body).toBe('Body here.\n')
  })

  it('appends a description when the frontmatter lacks one', () => {
    write(`---\nname: foo\n---\nBody.\n`)
    updateSkillFile(fp, { description: 'fresh' })
    const { meta, body } = parseFrontmatter(fp)
    expect(meta.description).toBe('fresh')
    expect(meta.name).toBe('foo')
    expect(body).toBe('Body.\n')
  })

  it('creates a frontmatter block when the file has none', () => {
    write('Just markdown body, no header.\n')
    updateSkillFile(fp, { description: 'now described' })
    const raw = fs.readFileSync(fp, 'utf-8')
    expect(raw.startsWith('---\n')).toBe(true)
    const { meta, body } = parseFrontmatter(fp)
    expect(meta.description).toBe('now described')
    expect(body).toBe('Just markdown body, no header.\n')
  })

  it('preserves unrelated frontmatter keys verbatim', () => {
    write(`---\nname: foo\ndescription: old\nallowed-tools: Bash,Read\nversion: 2\n---\nBody.\n`)
    updateSkillFile(fp, { description: 'changed' })
    const raw = fs.readFileSync(fp, 'utf-8')
    expect(raw).toContain('allowed-tools: Bash,Read')
    expect(raw).toContain('name: foo')
    expect(raw).toContain('version: 2')
  })

  it('quotes descriptions that contain colons or hashes safely', () => {
    write(`---\nname: foo\n---\nB.\n`)
    updateSkillFile(fp, { description: 'with: colon and #hash' })
    const { meta } = parseFrontmatter(fp)
    expect(meta.description).toBe('with: colon and #hash')
  })

  it('normalizes newlines to spaces (frontmatter is line-based)', () => {
    write(`---\nname: foo\n---\nB.\n`)
    updateSkillFile(fp, { description: 'line one\nline two' })
    const { meta } = parseFrontmatter(fp)
    expect(meta.description).toBe('line one line two')
  })

  it('rejects descriptions containing double quotes', () => {
    write(`---\nname: foo\n---\nB.\n`)
    expect(() => updateSkillFile(fp, { description: 'He said "hi"' })).toThrow(FrontmatterWriteError)
  })

  it('rejects descriptions containing backslashes', () => {
    write(`---\nname: foo\n---\nB.\n`)
    expect(() => updateSkillFile(fp, { description: 'path\\to\\thing' })).toThrow(FrontmatterWriteError)
  })
})

describe('updateSkillFile — body', () => {
  it('rewrites the body while preserving the frontmatter', () => {
    write(`---\nname: foo\ndescription: keep\n---\nOriginal body.\n`)
    updateSkillFile(fp, { body: '# New body\n\nMuch better.\n' })
    const { meta, body } = parseFrontmatter(fp)
    expect(meta.description).toBe('keep')
    expect(body).toBe('# New body\n\nMuch better.\n')
  })

  it('rewrites the body even when the file had no frontmatter', () => {
    write('Just text.\n')
    updateSkillFile(fp, { body: 'Replaced.\n' })
    expect(fs.readFileSync(fp, 'utf-8')).toBe('Replaced.\n')
  })
})

describe('updateSkillFile — both at once', () => {
  it('applies description and body updates in a single write', () => {
    write(`---\nname: foo\ndescription: old\n---\nold body\n`)
    updateSkillFile(fp, { description: 'new desc', body: 'new body\n' })
    const { meta, body } = parseFrontmatter(fp)
    expect(meta.description).toBe('new desc')
    expect(body).toBe('new body\n')
  })
})

describe('updateSkillFile — noop', () => {
  it('leaves the file untouched when neither field is provided', () => {
    const original = `---\nname: foo\ndescription: stays\n---\nbody\n`
    write(original)
    const mtimeBefore = fs.statSync(fp).mtimeMs
    updateSkillFile(fp, {})
    expect(fs.readFileSync(fp, 'utf-8')).toBe(original)
    // mtime should also be untouched (no write happened).
    expect(fs.statSync(fp).mtimeMs).toBe(mtimeBefore)
  })
})

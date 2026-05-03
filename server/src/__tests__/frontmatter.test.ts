import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseFrontmatter } from '../parser/frontmatter'

let tmp: string

function write(p: string, content: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-fm-'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('parseFrontmatter', () => {
  it('parses basic key/value frontmatter', () => {
    const fp = path.join(tmp, 'a.md')
    write(fp, '---\nname: my-skill\ndescription: does stuff\n---\nBody here.\n')
    const { meta, body } = parseFrontmatter(fp)
    expect(meta['name']).toBe('my-skill')
    expect(meta['description']).toBe('does stuff')
    expect(body).toMatch(/Body here\./)
  })

  it('strips double and single quotes from values', () => {
    const fp = path.join(tmp, 'b.md')
    write(fp, '---\na: "double quoted"\nb: \'single quoted\'\n---\n')
    const { meta } = parseFrontmatter(fp)
    expect(meta['a']).toBe('double quoted')
    expect(meta['b']).toBe('single quoted')
  })

  it('coerces true/false to booleans', () => {
    const fp = path.join(tmp, 'c.md')
    write(fp, '---\nenabled: true\nhidden: false\n---\n')
    const { meta } = parseFrontmatter(fp)
    expect(meta['enabled']).toBe(true)
    expect(meta['hidden']).toBe(false)
  })

  it('returns empty meta when no frontmatter', () => {
    const fp = path.join(tmp, 'd.md')
    write(fp, '# Just a heading\n\nSome body.\n')
    const { meta, body } = parseFrontmatter(fp)
    expect(meta).toEqual({})
    expect(body).toMatch(/Just a heading/)
  })

  it('skips lines without a colon', () => {
    const fp = path.join(tmp, 'e.md')
    write(fp, '---\nname: ok\nnot a kv line\nanother: val\n---\n')
    const { meta } = parseFrontmatter(fp)
    expect(meta['name']).toBe('ok')
    expect(meta['another']).toBe('val')
    expect(Object.keys(meta).length).toBe(2)
  })

  it('handles nested metadata.version via trim', () => {
    const fp = path.join(tmp, 'f.md')
    write(fp, '---\nname: versioned\nmetadata:\n  version: 2.0.0\n---\n')
    const { meta } = parseFrontmatter(fp)
    expect(meta['name']).toBe('versioned')
    // indented `version` key is trimmed to `version`
    expect(meta['version']).toBe('2.0.0')
  })

  it('returns empty meta on unreadable file', () => {
    const { meta, body, raw } = parseFrontmatter('/nonexistent/path/skill.md')
    expect(meta).toEqual({})
    expect(body).toBe('')
    expect(raw).toBe('')
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  diffAgainstBaseline,
  getBaseline,
  reconcileBaseline,
  writeBaseline,
  __test,
} from '../state/skillBaselines'

let tmp: string
let origHome: string | undefined

const ID = 'YmFzZWxpbmUtdGVzdC1za2lsbA' // base64 of "baseline-test-skill"

beforeEach(() => {
  origHome = process.env['HOME']
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-baseline-test-'))
  process.env['HOME'] = tmp
})

afterEach(() => {
  process.env['HOME'] = origHome
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('getBaseline', () => {
  it('returns null when no baseline has been written', () => {
    expect(getBaseline(ID)).toBeNull()
  })

  it('returns body + frontmatter + observedAt after a write', () => {
    writeBaseline(ID, '# Skill body\n', { description: 'hello' })
    const b = getBaseline(ID)
    expect(b?.body).toBe('# Skill body\n')
    expect(b?.frontmatter).toEqual({ description: 'hello' })
    expect(typeof b?.observedAt).toBe('string')
    expect(b?.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('defaults frontmatter to {} when written without it', () => {
    writeBaseline(ID, 'body\n')
    expect(getBaseline(ID)?.frontmatter).toEqual({})
  })
})

describe('diffAgainstBaseline', () => {
  it('reports first-seen when no baseline exists', () => {
    expect(diffAgainstBaseline(ID, 'anything').kind).toBe('first-seen')
  })

  it('reports unchanged when body and frontmatter match exactly', () => {
    writeBaseline(ID, 'same content\n', { type: 'skill' })
    expect(diffAgainstBaseline(ID, 'same content\n', { type: 'skill' }).kind).toBe('unchanged')
  })

  it('reports shadow-edit when body differs', () => {
    writeBaseline(ID, '# v1\nhello\n')
    const r = diffAgainstBaseline(ID, '# v1\nHELLO\n')
    expect(r.kind).toBe('shadow-edit')
    expect(r.summary).toMatch(/line 2/)
    expect(r.bodyBefore).toBe('# v1\nhello\n')
    expect(r.bodyAfter).toBe('# v1\nHELLO\n')
  })

  it('includes line-delta summary for added lines', () => {
    writeBaseline(ID, 'line1\nline2\n')
    const r = diffAgainstBaseline(ID, 'line1\nline2\nline3\nline4\n')
    expect(r.kind).toBe('shadow-edit')
    expect(r.summary).toMatch(/\+2 lines/)
  })

  it('includes line-delta summary for removed lines', () => {
    writeBaseline(ID, 'line1\nline2\nline3\n')
    const r = diffAgainstBaseline(ID, 'line1\n')
    expect(r.kind).toBe('shadow-edit')
    expect(r.summary).toMatch(/-2 lines/)
  })

  it('reports shadow-edit when only frontmatter changes', () => {
    writeBaseline(ID, 'same body\n', { description: 'old desc', type: 'skill' })
    const r = diffAgainstBaseline(ID, 'same body\n', { description: 'new desc', type: 'skill' })
    expect(r.kind).toBe('shadow-edit')
    expect(r.summary).toMatch(/description/)
    expect(r.frontmatterChanges).toHaveLength(1)
    expect(r.frontmatterChanges![0]).toEqual({ key: 'description', before: 'old desc', after: 'new desc' })
    expect(r.bodyBefore).toBeUndefined()
    expect(r.bodyAfter).toBeUndefined()
  })

  it('reports shadow-edit when type field changes', () => {
    writeBaseline(ID, 'body\n', { type: 'command' })
    const r = diffAgainstBaseline(ID, 'body\n', { type: 'skill' })
    expect(r.kind).toBe('shadow-edit')
    expect(r.frontmatterChanges).toHaveLength(1)
    expect(r.frontmatterChanges![0].key).toBe('type')
  })

  it('reports shadow-edit with combined summary when both change', () => {
    writeBaseline(ID, 'old body\n', { description: 'old' })
    const r = diffAgainstBaseline(ID, 'new body\n', { description: 'new' })
    expect(r.kind).toBe('shadow-edit')
    expect(r.summary).toMatch(/description/)
    expect(r.frontmatterChanges).toHaveLength(1)
    expect(r.bodyBefore).toBe('old body\n')
    expect(r.bodyAfter).toBe('new body\n')
  })

  it('reports unchanged when frontmatter is added/omitted as empty vs {}', () => {
    writeBaseline(ID, 'body\n', {})
    expect(diffAgainstBaseline(ID, 'body\n', {}).kind).toBe('unchanged')
  })
})

describe('reconcileBaseline', () => {
  it('first sighting writes the baseline and reports first-seen', () => {
    expect(getBaseline(ID)).toBeNull()
    const r = reconcileBaseline(ID, 'fresh content\n', { type: 'skill' })
    expect(r.kind).toBe('first-seen')
    const b = getBaseline(ID)
    expect(b?.body).toBe('fresh content\n')
    expect(b?.frontmatter).toEqual({ type: 'skill' })
  })

  it('second sighting with unchanged content does NOT rewrite', async () => {
    reconcileBaseline(ID, 'content\n')
    const first = getBaseline(ID)?.observedAt
    await new Promise(r => setTimeout(r, 25))
    reconcileBaseline(ID, 'content\n')
    expect(getBaseline(ID)?.observedAt).toBe(first)
  })

  it('shadow edit does NOT auto-update the baseline', () => {
    reconcileBaseline(ID, 'original\n')
    const r = reconcileBaseline(ID, 'modified\n')
    expect(r.kind).toBe('shadow-edit')
    expect(getBaseline(ID)?.body).toBe('original\n')
  })

  it('an explicit writeBaseline after a shadow-edit clears the drift', () => {
    reconcileBaseline(ID, 'original\n')
    expect(reconcileBaseline(ID, 'modified\n').kind).toBe('shadow-edit')
    writeBaseline(ID, 'modified\n')
    expect(reconcileBaseline(ID, 'modified\n').kind).toBe('unchanged')
  })

  it('frontmatter shadow-edit does NOT auto-update', () => {
    reconcileBaseline(ID, 'body\n', { description: 'orig' })
    const r = reconcileBaseline(ID, 'body\n', { description: 'changed' })
    expect(r.kind).toBe('shadow-edit')
    expect(getBaseline(ID)?.frontmatter).toEqual({ description: 'orig' })
  })
})

describe('storage layout', () => {
  it('stores baselines under ~/.loadoutsmith/skill-baselines/<id>.json', () => {
    writeBaseline(ID, 'x\n')
    expect(fs.existsSync(__test.fileFor(ID))).toBe(true)
    expect(__test.fileFor(ID)).toBe(
      path.join(tmp, '.loadoutsmith', 'skill-baselines', `${ID}.json`),
    )
  })
})

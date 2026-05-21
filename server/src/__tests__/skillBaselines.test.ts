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

  it('returns content + observedAt after a write', () => {
    writeBaseline(ID, '# Skill body\n')
    const b = getBaseline(ID)
    expect(b?.content).toBe('# Skill body\n')
    expect(typeof b?.observedAt).toBe('string')
    expect(b?.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('diffAgainstBaseline', () => {
  it('reports first-seen when no baseline exists', () => {
    expect(diffAgainstBaseline(ID, 'anything').kind).toBe('first-seen')
  })

  it('reports unchanged when current matches baseline exactly', () => {
    writeBaseline(ID, 'same content\n')
    expect(diffAgainstBaseline(ID, 'same content\n').kind).toBe('unchanged')
  })

  it('reports shadow-edit when content differs', () => {
    writeBaseline(ID, '# v1\nhello\n')
    const r = diffAgainstBaseline(ID, '# v1\nHELLO\n')
    expect(r.kind).toBe('shadow-edit')
    expect(r.summary).toMatch(/line 2/)
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
})

describe('reconcileBaseline', () => {
  it('first sighting writes the baseline and reports first-seen', () => {
    expect(getBaseline(ID)).toBeNull()
    const r = reconcileBaseline(ID, 'fresh content\n')
    expect(r.kind).toBe('first-seen')
    expect(getBaseline(ID)?.content).toBe('fresh content\n')
  })

  it('second sighting with unchanged content does NOT rewrite', async () => {
    reconcileBaseline(ID, 'content\n')
    const first = getBaseline(ID)?.observedAt
    // Sleep so the mtime would tick if we rewrote.
    await new Promise(r => setTimeout(r, 25))
    reconcileBaseline(ID, 'content\n')
    expect(getBaseline(ID)?.observedAt).toBe(first)
  })

  it('shadow edit does NOT auto-update the baseline', () => {
    reconcileBaseline(ID, 'original\n')
    const r = reconcileBaseline(ID, 'modified\n')
    expect(r.kind).toBe('shadow-edit')
    expect(getBaseline(ID)?.content).toBe('original\n')
  })

  it('an explicit writeBaseline after a shadow-edit clears the drift', () => {
    reconcileBaseline(ID, 'original\n')
    expect(reconcileBaseline(ID, 'modified\n').kind).toBe('shadow-edit')
    writeBaseline(ID, 'modified\n') // user clicks "Re-baseline"
    expect(reconcileBaseline(ID, 'modified\n').kind).toBe('unchanged')
  })
})

describe('storage layout', () => {
  it('stores baselines under ~/.loadoutsmith/skill-baselines/<id>.md', () => {
    writeBaseline(ID, 'x\n')
    expect(fs.existsSync(__test.fileFor(ID))).toBe(true)
    expect(__test.fileFor(ID)).toBe(
      path.join(tmp, '.loadoutsmith', 'skill-baselines', `${ID}.md`),
    )
  })
})

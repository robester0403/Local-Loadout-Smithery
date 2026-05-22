import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseFrontmatter } from '../parser/frontmatter'
import { writeBaseline, diffAgainstBaseline, __test as baselineTest } from '../state/skillBaselines'

// Regression for LOC-40: PATCH and baseline/accept routes used to write the
// full file (including frontmatter) as the baseline, but scanner/health.ts
// reconciles against `skill.body` (frontmatter-stripped). This locks down
// the body-only contract that route helpers now follow.

const ID = Buffer.from('/fake/path/SKILL.md').toString('base64')
const SKILL_FILE = `---
name: my-skill
description: original
---
# Body
Some content here.
`

let tmp: string
let origHome: string | undefined

beforeEach(() => {
  origHome = process.env['HOME']
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-baseline-fmt-'))
  process.env['HOME'] = tmp
})

afterEach(() => {
  if (origHome !== undefined) process.env['HOME'] = origHome
  else delete process.env['HOME']
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('shadow-edit baseline format (LOC-40)', () => {
  it('baseline written as body-only matches discovery body input', () => {
    const filePath = path.join(tmp, 'SKILL.md')
    fs.writeFileSync(filePath, SKILL_FILE)

    const { body } = parseFrontmatter(filePath)
    writeBaseline(ID, body)

    // Discovery passes skill.body (the same body) into reconcileBaseline.
    expect(diffAgainstBaseline(ID, body).kind).toBe('unchanged')
  })

  it('writing the full file as baseline produces a false shadow-edit on next reconcile', () => {
    // Negative case: this is the pre-LOC-40 behavior. Locking it down so a
    // future regression in the routes is obvious.
    const filePath = path.join(tmp, 'SKILL.md')
    fs.writeFileSync(filePath, SKILL_FILE)

    writeBaseline(ID, SKILL_FILE) // wrong: full file with frontmatter

    const { body } = parseFrontmatter(filePath)
    expect(diffAgainstBaseline(ID, body).kind).toBe('shadow-edit')
  })

  it('baseline storage path is keyed on $HOME (test isolation sanity)', () => {
    // Confirms the test's HOME swap actually redirects the baseline file
    // away from the developer's real ~/.loadoutsmith.
    expect(baselineTest.fileFor(ID)).toContain(tmp)
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { computeHealth } from '../scanner/health'
import { startMarker, endMarker, stripSuperRouterBlocks } from '../superRouter/writer'
import type { Skill } from '../scanner/types'

// LOC-41: enabling a Codex (or any) SuperRouter bundle writes a trigger
// block into the same file (~/.codex/AGENTS.md) that Codex discovery
// returns as a skill. Without stripping the block before shadow-edit
// reconciliation, the app surfaces its own write as a shadow edit.

const ORIGINAL = '# my notes\n'

function withBlock(bundleId: string): string {
  return [
    ORIGINAL,
    startMarker(bundleId),
    '## Skill group: example',
    '**Trigger:** When the user does X',
    '**On match only:** read `./super-router/example.md`',
    endMarker(bundleId),
    '',
  ].join('\n')
}

function baseSkill(body: string, overrides: Partial<Skill> = {}): Omit<Skill, 'health'> {
  return {
    id: 'shadow-test-id',
    name: 'AGENTS',
    description: 'codex agents file',
    version: '',
    type: 'skill',
    scope: 'global',
    account: 'codex',
    path: '/fake/.codex/AGENTS.md',
    realpath: '/fake/.codex/AGENTS.md',
    isSymlink: false,
    body,
    bodyBytes: Buffer.byteLength(body, 'utf-8'),
    bodyTokens: 0,
    listingBytes: 0,
    listingTokens: 0,
    frontmatter: {},
    lastModified: new Date().toISOString(),
    disabled: false,
    references: [],
    ...overrides,
  }
}

let tmpHome: string
let origHome: string | undefined

beforeEach(() => {
  origHome = process.env['HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-shadow-bundle-'))
  process.env['HOME'] = tmpHome
})

afterEach(() => {
  if (origHome !== undefined) process.env['HOME'] = origHome
  else delete process.env['HOME']
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe('stripSuperRouterBlocks', () => {
  it('removes a single block, leaving surrounding content intact', () => {
    const input = withBlock('abc123')
    expect(stripSuperRouterBlocks(input)).toBe(ORIGINAL)
  })

  it('removes multiple blocks with different ids', () => {
    const input = [
      ORIGINAL,
      startMarker('abc'),
      'first block',
      endMarker('abc'),
      'middle\n',
      startMarker('def'),
      'second block',
      endMarker('def'),
    ].join('\n')
    // The strip pattern consumes one leading and one trailing newline
    // around each block so the surrounding content joins cleanly.
    expect(stripSuperRouterBlocks(input)).toBe(`${ORIGINAL}middle\n`)
  })

  it('is a no-op when no blocks present', () => {
    expect(stripSuperRouterBlocks(ORIGINAL)).toBe(ORIGINAL)
  })
})

describe('shadow-edit detection with super-router blocks (LOC-41)', () => {
  it('first-seen body without block; later body with block → unchanged', () => {
    // Step 1: discovery sees AGENTS.md before any bundle is enabled.
    // computeHealth writes baseline = stripped body.
    const first = computeHealth(baseSkill(ORIGINAL))
    expect(first.issues.find(i => i.message.startsWith('Shadow edit'))).toBeUndefined()

    // Step 2: SuperRouter writes a trigger block. Discovery sees the new
    // file. After strip, the comparable body still matches the baseline.
    const second = computeHealth(baseSkill(withBlock('abc123')))
    expect(second.issues.find(i => i.message.startsWith('Shadow edit'))).toBeUndefined()
  })

  it('genuine user edit outside the block still surfaces shadow-edit', () => {
    // Baseline = ORIGINAL.
    computeHealth(baseSkill(ORIGINAL))

    // User edits outside the block (added a new line). This SHOULD trip.
    const edited = `${ORIGINAL}\nuser added a line\n`
    const result = computeHealth(baseSkill(edited))
    expect(result.issues.find(i => i.message.startsWith('Shadow edit'))).toBeDefined()
  })
})

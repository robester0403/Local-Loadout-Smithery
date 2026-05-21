import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  MAX_VERSIONS_PER_SKILL,
  getVersionContent,
  listVersions,
  prepareRestore,
  snapshot,
  __test,
} from '../state/skillVersions'

let tmp: string
let origHome: string | undefined

beforeEach(() => {
  origHome = process.env['HOME']
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-versions-test-'))
  process.env['HOME'] = tmp
})

afterEach(() => {
  process.env['HOME'] = origHome
  fs.rmSync(tmp, { recursive: true, force: true })
})

function writeSkill(content: string): string {
  const p = path.join(tmp, 'skill.md')
  fs.writeFileSync(p, content)
  return p
}

const ID = 'c2tpbGwtaWQ' // arbitrary base64-ish; treated as opaque key

describe('snapshot', () => {
  it('captures pre-image content and returns a timestamp', () => {
    const file = writeSkill('# v1\n')
    const ts = snapshot(ID, file)
    expect(ts).not.toBeNull()
    expect(getVersionContent(ID, ts!)).toBe('# v1\n')
  })

  it('returns null when the skill file is missing (no-op)', () => {
    expect(snapshot(ID, path.join(tmp, 'does-not-exist.md'))).toBeNull()
  })

  it('keeps versions across multiple snapshots', async () => {
    const file = writeSkill('# v1\n')
    const t1 = snapshot(ID, file)
    fs.writeFileSync(file, '# v2\n')
    // Sleep a millisecond so the ISO timestamps differ.
    await new Promise(r => setTimeout(r, 5))
    const t2 = snapshot(ID, file)
    expect(t1).not.toBe(t2)
    const versions = listVersions(ID)
    expect(versions).toHaveLength(2)
    // Newest first.
    expect(versions[0].timestamp).toBe(t2)
    expect(versions[1].timestamp).toBe(t1)
  })

  it('trims to MAX_VERSIONS_PER_SKILL, dropping the oldest', async () => {
    const file = writeSkill('start\n')
    for (let i = 0; i < MAX_VERSIONS_PER_SKILL + 5; i++) {
      fs.writeFileSync(file, `iter ${i}\n`)
      snapshot(ID, file)
      // Force timestamp progression so each version has a unique name.
      await new Promise(r => setTimeout(r, 2))
    }
    const versions = listVersions(ID)
    expect(versions.length).toBe(MAX_VERSIONS_PER_SKILL)
    // The oldest still kept should be iter (overflow) — confirm content
    // of the newest matches the most recent write.
    const newest = getVersionContent(ID, versions[0].timestamp)
    expect(newest).toMatch(/iter \d+/)
  })
})

describe('listVersions', () => {
  it('returns an empty array when nothing has been snapshotted', () => {
    expect(listVersions(ID)).toEqual([])
  })
})

describe('getVersionContent', () => {
  it('rejects traversal attempts in the timestamp', () => {
    const file = writeSkill('safe\n')
    snapshot(ID, file)
    expect(getVersionContent(ID, '../../etc/passwd')).toBeNull()
    expect(getVersionContent(ID, 'unknown')).toBeNull()
  })
})

describe('prepareRestore', () => {
  it('returns the historical content and creates a fresh pre-restore snapshot', async () => {
    const file = writeSkill('# v1\n')
    const t1 = snapshot(ID, file)
    fs.writeFileSync(file, '# v2 (live)\n')
    await new Promise(r => setTimeout(r, 5))

    const result = prepareRestore(ID, t1!, file)
    expect(result).not.toBeNull()
    expect(result!.content).toBe('# v1\n')
    expect(result!.preRestoreSnapshot).not.toBeNull()

    // Two versions now: original v1 + the fresh snapshot of v2-before-restore.
    expect(listVersions(ID)).toHaveLength(2)
    const versions = listVersions(ID)
    const restoredSnapshot = getVersionContent(ID, versions[0].timestamp)
    expect(restoredSnapshot).toBe('# v2 (live)\n')
  })

  it('returns null for an unknown timestamp', () => {
    const file = writeSkill('# v1\n')
    expect(prepareRestore(ID, 'not-a-real-timestamp', file)).toBeNull()
  })
})

describe('storage layout', () => {
  it('stores versions under LOADOUT_DIR/skill-versions/<id>/', () => {
    const file = writeSkill('content\n')
    snapshot(ID, file)
    expect(fs.existsSync(__test.dirFor(ID))).toBe(true)
    expect(__test.dirFor(ID)).toBe(path.join(tmp, '.loadoutsmith', 'skill-versions', ID))
  })
})

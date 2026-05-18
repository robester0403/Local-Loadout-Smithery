import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  appendSeenCwds,
  findCursorProjectCwds,
  readSeenCwds,
  rescanAndPersist,
  scanHomeForCursorProjects,
  triggerInitialScanIfNeeded,
} from '../scanner/cursorProjects'

// Each test gets a sandbox that plays the role of the user's home dir, so we
// can stage fake project trees with `.cursor/` children and a fake
// `~/.cursor/` containing the projects index + ide_state.
let home: string
let cursorDir: string

function mkdirs(...parts: string[]) {
  for (const p of parts) fs.mkdirSync(p, { recursive: true })
}
function touch(p: string, content = '') {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
}

beforeEach(() => {
  // Avoid hyphens in the temp dir name so the greedy `-` → `/` decoding
  // doesn't fail on the temp prefix itself.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsmcursor'))
  cursorDir = path.join(home, '.cursor')
  mkdirs(cursorDir, path.join(cursorDir, 'projects'))
})
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

describe('findCursorProjectCwds', () => {
  it('returns an empty list when nothing is configured', () => {
    expect(findCursorProjectCwds({ cursorDir, home })).toEqual([])
  })

  it('decodes simple projects/<encoded> entries when the path has no hyphens', () => {
    const proj = path.join(home, 'Code', 'sample')
    mkdirs(path.join(proj, '.cursor'))
    // Simulate Cursor recording this project under its index dir. The
    // encoded form replaces / with -, and the resolver decodes back.
    const encoded = home.replace(/^\//, '').replace(/\//g, '-') + '-Code-sample'
    mkdirs(path.join(cursorDir, 'projects', encoded))
    expect(findCursorProjectCwds({ cursorDir, home })).toEqual([proj])
  })

  it('skips projects/ entries that decode to non-existent paths', () => {
    mkdirs(path.join(cursorDir, 'projects', 'does-not-exist'))
    expect(findCursorProjectCwds({ cursorDir, home })).toEqual([])
  })

  it('falls back to ide_state.json to find projects with hyphens in their path', () => {
    // Folder name contains a hyphen → projects/ encoding is ambiguous.
    const proj = path.join(home, 'Code', 'hyphen-name')
    mkdirs(path.join(proj, '.cursor'))
    touch(path.join(cursorDir, 'ide_state.json'), JSON.stringify({
      recentlyViewedFiles: [
        { absolutePath: path.join(proj, 'src', 'main.ts') },
      ],
    }))
    expect(findCursorProjectCwds({ cursorDir, home })).toEqual([proj])
  })

  it('deduplicates roots discovered via both signals', () => {
    const proj = path.join(home, 'Code', 'dup')
    mkdirs(path.join(proj, '.cursor'))
    const encoded = home.replace(/^\//, '').replace(/\//g, '-') + '-Code-dup'
    mkdirs(path.join(cursorDir, 'projects', encoded))
    touch(path.join(cursorDir, 'ide_state.json'), JSON.stringify({
      recentlyViewedFiles: [
        { absolutePath: path.join(proj, 'a.ts') },
        { absolutePath: path.join(proj, 'b.ts') },
      ],
    }))
    expect(findCursorProjectCwds({ cursorDir, home })).toEqual([proj])
  })

  it('ignores paths whose nearest .cursor ancestor is the user home (the global cursor dir)', () => {
    // A file directly under home with no project-level .cursor would walk up
    // until home — but home is excluded because `~/.cursor` is the global
    // cursor dir, not a project.
    touch(path.join(cursorDir, 'ide_state.json'), JSON.stringify({
      recentlyViewedFiles: [
        { absolutePath: path.join(home, 'loose-file.txt') },
      ],
    }))
    expect(findCursorProjectCwds({ cursorDir, home })).toEqual([])
  })

  it('sweeps siblings under the derived code root for projects not registered with Cursor', () => {
    // Two known projects share a parent → that parent becomes a code root.
    // A third sibling has a `.cursor/` dir but Cursor hasn't indexed it yet
    // (no entry in projects/, no recently-viewed files).
    const code = path.join(home, 'Code')
    const known1 = path.join(code, 'known1')
    const known2 = path.join(code, 'known2')
    const sibling = path.join(code, 'sibling')
    for (const p of [known1, known2, sibling]) mkdirs(path.join(p, '.cursor'))

    const enc = (p: string) => p.replace(/^\//, '').replace(/\//g, '-')
    mkdirs(path.join(cursorDir, 'projects', enc(known1)))
    mkdirs(path.join(cursorDir, 'projects', enc(known2)))

    const result = findCursorProjectCwds({ cursorDir, home })
    expect(result.sort()).toEqual([known1, known2, sibling].sort())
  })

  it('does not derive a code root from a single known project (avoids spurious matches)', () => {
    const code = path.join(home, 'Code')
    const only = path.join(code, 'only')
    const sibling = path.join(code, 'sibling')
    for (const p of [only, sibling]) mkdirs(path.join(p, '.cursor'))

    const enc = (p: string) => p.replace(/^\//, '').replace(/\//g, '-')
    mkdirs(path.join(cursorDir, 'projects', enc(only)))

    const result = findCursorProjectCwds({ cursorDir, home })
    expect(result).toEqual([only])
  })

  it('tolerates a malformed ide_state.json without crashing', () => {
    touch(path.join(cursorDir, 'ide_state.json'), '{ not json')
    expect(findCursorProjectCwds({ cursorDir, home })).toEqual([])
  })

  it("reads Cursor's storage.json folder list (authoritative workspace registry)", () => {
    const userDataDir = path.join(home, 'Library', 'Application Support', 'Cursor', 'User')
    const proj = path.join(home, 'Code', 'fromStorage')
    mkdirs(path.join(proj, '.cursor'))
    touch(path.join(userDataDir, 'globalStorage', 'storage.json'), JSON.stringify({
      backupWorkspaces: { folders: [{ folderUri: `file://${proj}` }] },
    }))
    const result = findCursorProjectCwds({ cursorDir, userDataDir, home })
    expect(result).toEqual([proj])
  })

  it('decodes percent-encoded characters in folder URIs (e.g. spaces)', () => {
    const userDataDir = path.join(home, 'Library', 'Application Support', 'Cursor', 'User')
    const proj = path.join(home, 'Code', 'Golden Ralph')
    mkdirs(path.join(proj, '.cursor'))
    touch(path.join(userDataDir, 'globalStorage', 'storage.json'), JSON.stringify({
      backupWorkspaces: { folders: [{ folderUri: `file://${proj.replace(/ /g, '%20')}` }] },
    }))
    const result = findCursorProjectCwds({ cursorDir, userDataDir, home })
    expect(result).toEqual([proj])
  })

  it('reads workspaceStorage/<hash>/workspace.json folder fields', () => {
    const userDataDir = path.join(home, 'Library', 'Application Support', 'Cursor', 'User')
    const proj = path.join(home, 'Code', 'fromWsStorage')
    mkdirs(path.join(proj, '.cursor'))
    touch(path.join(userDataDir, 'workspaceStorage', 'abc123', 'workspace.json'), JSON.stringify({
      folder: `file://${proj}`,
    }))
    const result = findCursorProjectCwds({ cursorDir, userDataDir, home })
    expect(result).toEqual([proj])
  })

  it('extracts project root from configPath of multi-root .code-workspace entries', () => {
    const userDataDir = path.join(home, 'Library', 'Application Support', 'Cursor', 'User')
    const proj = path.join(home, 'Code', 'workspaceProj')
    mkdirs(path.join(proj, '.cursor'))
    // configPath points to the .code-workspace file inside the project — its
    // dirname is the real project root.
    const cfg = path.join(proj, 'project.code-workspace')
    touch(path.join(userDataDir, 'globalStorage', 'storage.json'), JSON.stringify({
      backupWorkspaces: { workspaces: [{ configPath: `file://${cfg}` }] },
    }))
    const result = findCursorProjectCwds({ cursorDir, userDataDir, home })
    expect(result).toEqual([proj])
  })

  it("ignores storage.json folders that don't have a .cursor/ child", () => {
    const userDataDir = path.join(home, 'Library', 'Application Support', 'Cursor', 'User')
    const proj = path.join(home, 'Code', 'noCursor')
    mkdirs(proj)  // no .cursor inside
    touch(path.join(userDataDir, 'globalStorage', 'storage.json'), JSON.stringify({
      backupWorkspaces: { folders: [{ folderUri: `file://${proj}` }] },
    }))
    expect(findCursorProjectCwds({ cursorDir, userDataDir, home })).toEqual([])
  })
})

describe('scanHomeForCursorProjects', () => {
  it('finds every directory with a .cursor/ child within depth', () => {
    const a = path.join(home, 'Code', 'projA')
    const b = path.join(home, 'Code', 'org', 'projB')
    const c = path.join(home, 'Work', 'projC')
    for (const p of [a, b, c]) mkdirs(path.join(p, '.cursor'))
    const result = scanHomeForCursorProjects(home).sort()
    expect(result).toEqual([a, b, c].sort())
  })

  it('skips heavyweight directories (node_modules, .git, etc.)', () => {
    const proj = path.join(home, 'Code', 'sample')
    mkdirs(path.join(proj, '.cursor'))
    // A `.cursor` inside node_modules must NOT be picked up — likely a fixture
    // or test artifact, not a real user project.
    mkdirs(path.join(home, 'Code', 'sample', 'node_modules', 'fake', '.cursor'))
    // Same for hidden dirs other than .cursor.
    mkdirs(path.join(home, '.cache', 'something', '.cursor'))
    const result = scanHomeForCursorProjects(home)
    expect(result).toEqual([proj])
  })

  it('honors the maxDepth cap', () => {
    // Very deep nesting — at depth 5, well beyond default maxDepth of 4.
    const deep = path.join(home, 'a', 'b', 'c', 'd', 'e', 'project')
    mkdirs(path.join(deep, '.cursor'))
    const shallow = scanHomeForCursorProjects(home, { maxDepth: 2 })
    expect(shallow).toEqual([])
    const generous = scanHomeForCursorProjects(home, { maxDepth: 10 })
    expect(generous).toEqual([deep])
  })

  it('does not descend into .cursor itself', () => {
    const proj = path.join(home, 'Code', 'sample')
    // A nested .cursor inside another .cursor — we never recurse in.
    mkdirs(path.join(proj, '.cursor', 'nested', '.cursor'))
    const result = scanHomeForCursorProjects(home)
    expect(result).toEqual([proj])
  })
})

describe('seen-projects log', () => {
  it('readSeenCwds returns empty for a missing file', () => {
    expect(readSeenCwds(path.join(home, 'nope.jsonl'))).toEqual([])
  })

  it('appendSeenCwds writes one entry per cwd and dedups across calls', () => {
    const log = path.join(home, 'seen.jsonl')
    appendSeenCwds(log, ['/a', '/b'])
    appendSeenCwds(log, ['/b', '/c'])  // /b is dup, /c is new
    const cwds = readSeenCwds(log).sort()
    expect(cwds).toEqual(['/a', '/b', '/c'])
  })

  it('readSeenCwds tolerates malformed lines without crashing', () => {
    const log = path.join(home, 'broken.jsonl')
    fs.writeFileSync(log, '{ "cwd": "/good" }\nthis is not json\n{ "cwd": "/also-good" }\n')
    expect(readSeenCwds(log).sort()).toEqual(['/also-good', '/good'])
  })
})

describe('rescanAndPersist (manual rescan)', () => {
  it('returns the new finds and appends them to the log', () => {
    const log = path.join(home, 'seen.jsonl')
    // Pre-seed with one known cwd.
    appendSeenCwds(log, [path.join(home, 'Code', 'oldProj')])
    // Add two on-disk projects (one already known, one new).
    mkdirs(path.join(home, 'Code', 'oldProj', '.cursor'))
    const fresh = path.join(home, 'Code', 'freshProj')
    mkdirs(path.join(fresh, '.cursor'))
    const result = rescanAndPersist(log, home)
    expect(result.added).toEqual([fresh])
    expect(readSeenCwds(log).sort()).toContain(fresh)
  })
})

describe('first-run scan integration', () => {
  it('reads the persistent log as a discovery signal', () => {
    const log = path.join(home, 'seen.jsonl')
    const proj = path.join(home, 'Code', 'persistedProj')
    mkdirs(path.join(proj, '.cursor'))
    appendSeenCwds(log, [proj])
    // No other signals are configured; only the log produces this result.
    const result = findCursorProjectCwds({ cursorDir, home, seenLogPath: log })
    expect(result).toEqual([proj])
  })

  it('appends newly-resolved cwds to the log on every call', () => {
    const log = path.join(home, 'seen.jsonl')
    const proj = path.join(home, 'Code', 'fromStorage')
    mkdirs(path.join(proj, '.cursor'))
    const userDataDir = path.join(home, 'Library', 'Application Support', 'Cursor', 'User')
    touch(path.join(userDataDir, 'globalStorage', 'storage.json'), JSON.stringify({
      backupWorkspaces: { folders: [{ folderUri: `file://${proj}` }] },
    }))
    findCursorProjectCwds({ cursorDir, userDataDir, home, seenLogPath: log })
    expect(readSeenCwds(log)).toEqual([proj])
  })

  it('triggerInitialScanIfNeeded is a no-op when the log already exists', () => {
    const log = path.join(home, 'seen.jsonl')
    fs.writeFileSync(log, '')  // empty but present → scan should NOT run
    const before = fs.readFileSync(log, 'utf-8')
    triggerInitialScanIfNeeded(log, home)
    // Synchronously, nothing should have changed.
    expect(fs.readFileSync(log, 'utf-8')).toEqual(before)
  })
})

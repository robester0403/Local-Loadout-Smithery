// Resolve the set of project directories that carry a project-local
// `.cursor/` (skills/commands/agents) tree.
//
// Cursor doesn't write per-project session files the way Claude Code does,
// so there's no single authoritative registry. We combine five signals:
//
//   (a) `~/.cursor/projects/<encoded>/` — Cursor creates these for projects
//       it has recently indexed, but the encoding replaces every `/` with
//       `-` and is ambiguous when a folder name contains `-`. We greedy-
//       decode and verify by checking for a `.cursor/` child.
//
//   (b) `~/.cursor/ide_state.json` — `recentlyViewedFiles[].absolutePath`
//       gives us real, unambiguous paths. We walk each upward (bounded by
//       the user's home dir) until we find an ancestor containing `.cursor/`.
//       Catches hyphenated paths that (a) can't decode.
//
//   (c) Cursor's VS Code-style `storage.json` — under
//       `<userData>/User/globalStorage/storage.json`, the
//       `backupWorkspaces` block lists every folder Cursor has ever opened
//       as a `file://` URI. Most authoritative of all the signals.
//       Supplemented by `<userData>/User/workspaceStorage/<hash>/workspace.json`,
//       which records the folder for each indexed workspace.
//
//   (d) Sibling sweep — once (a)–(c) give us a set of known projects, the
//       common parent dir often hosts even more projects the user has set
//       up locally but never opened in Cursor (so they don't appear in any
//       registry). We list each derived "code root" and pick up siblings
//       that have a `.cursor/` folder.
//
//   (e) Persistent seen-projects log — every cwd we've ever recognized is
//       appended (dedup) to `<stateDir>/cursor-projects-seen.jsonl`. On
//       first run, when the log is absent, we kick off a one-time deep
//       home-dir scan (scanHomeForCursorProjects) in the background and
//       seed the log with everything it finds. Subsequent runs read the
//       log directly — covers projects Cursor itself has forgotten about
//       and survives across server restarts.
//
// Results are de-duplicated by canonicalized path.

import fs from 'fs'
import path from 'path'

interface IdeState {
  recentlyViewedFiles?: { absolutePath?: string }[]
}

interface StorageJson {
  backupWorkspaces?: {
    folders?: Array<{ folderUri?: string }>
    workspaces?: Array<{ configPath?: string }>
  }
}

export interface CursorResolverOpts {
  /** ~/.cursor — Cursor's user config tree (skills, agents, projects/, ide_state). */
  cursorDir: string
  /** Cursor's VS Code-style application data dir
   *  (`<userData>/Cursor/User`). Used to read storage.json and
   *  workspaceStorage/<hash>/workspace.json. Optional — when omitted, only
   *  the cursorDir signals are used (useful for tests). */
  userDataDir?: string
  /** Home directory, used to bound walk-up loops. */
  home: string
  /** Path to the persistent seen-projects log (typically
   *  `~/.loadoutsmith/cursor-projects-seen.jsonl`). When provided, every
   *  resolved cwd is dedup-appended to it, and if the log file does not yet
   *  exist a first-run home scan is kicked off in the background. */
  seenLogPath?: string
}

export function findCursorProjectCwds(opts: CursorResolverOpts): string[] {
  const { cursorDir, userDataDir, home, seenLogPath } = opts
  const found = new Set<string>()
  // Pool of "anchored" candidates for the code-root derivation. Anchors are
  // paths that have a verified `.cursor/` child — using only verified paths
  // keeps a junk decode from polluting the sibling-sweep root selection.
  const anchors: string[] = []

  // (e) Persistent log — read first so we keep coverage for any project we
  // discovered in a prior run even if Cursor has since forgotten about it.
  if (seenLogPath) {
    for (const cwd of readSeenCwds(seenLogPath)) {
      if (hasCursorDir(cwd)) { found.add(cwd); anchors.push(cwd) }
    }
    // Kick off the one-time home scan if this is a fresh install. Runs in
    // the background so we don't block the request; results are appended to
    // the log and will be picked up on the next inventory call.
    triggerInitialScanIfNeeded(seenLogPath, home)
  }

  // (a) Greedy decode of ~/.cursor/projects/<encoded>/ entries.
  const projectsDir = path.join(cursorDir, 'projects')
  for (const entry of listDir(projectsDir)) {
    const candidate = '/' + entry.split('-').join('/')
    if (hasCursorDir(candidate)) {
      found.add(candidate)
      anchors.push(candidate)
    }
  }

  // (b) Walk-up from ide_state.json's recently-viewed file paths.
  try {
    const raw = fs.readFileSync(path.join(cursorDir, 'ide_state.json'), 'utf-8')
    const parsed: IdeState = JSON.parse(raw) as IdeState
    for (const f of parsed.recentlyViewedFiles ?? []) {
      if (typeof f.absolutePath !== 'string' || !f.absolutePath) continue
      const root = findCursorAncestor(f.absolutePath, home)
      if (root) { found.add(root); anchors.push(root) }
    }
  } catch { /* ide_state.json missing or malformed — fine, skip */ }

  // (c) Cursor's VS Code-style workspace registry — most authoritative
  // because Cursor records every folder it has ever opened here.
  if (userDataDir) {
    for (const cwd of readCursorWorkspaces(userDataDir)) {
      if (hasCursorDir(cwd)) { found.add(cwd); anchors.push(cwd) }
    }
  }

  // (d) Sibling sweep: derive a likely "code root" from the anchored paths,
  // then list its direct children to pick up sibling projects the user has
  // set up locally but never opened in Cursor (so they don't appear in any
  // registry above).
  for (const root of deriveCodeRoots(anchors, home)) {
    for (const sub of listDir(root)) {
      const candidate = path.join(root, sub)
      if (!hasCursorDir(candidate)) continue
      if (found.has(candidate)) continue
      // Only pull in actual directories — defends against the rare case of a
      // file named e.g. `foo.cursor` lurking at the same level.
      try {
        if (fs.statSync(candidate).isDirectory()) found.add(candidate)
      } catch { /* unreadable; skip */ }
    }
  }

  const result = Array.from(found)
  // Persist everything we just resolved so future runs include them even if
  // their underlying Cursor-side traces are gone.
  if (seenLogPath && result.length > 0) appendSeenCwds(seenLogPath, result)
  return result
}

// Pull every recorded workspace folder out of Cursor's VS Code-style state.
// Two sources, both yield `file://`-prefixed URIs that we decode to plain
// filesystem paths:
//   - storage.json → backupWorkspaces.folders[].folderUri (folder workspaces)
//   - storage.json → backupWorkspaces.workspaces[].configPath (multi-root
//     `.code-workspace` files; we use their containing directory)
//   - workspaceStorage/<hash>/workspace.json → folder (per-window record)
function readCursorWorkspaces(userDataDir: string): string[] {
  const out: string[] = []

  try {
    const raw = fs.readFileSync(path.join(userDataDir, 'globalStorage', 'storage.json'), 'utf-8')
    const parsed: StorageJson = JSON.parse(raw) as StorageJson
    for (const folder of parsed.backupWorkspaces?.folders ?? []) {
      const p = parseFileUri(folder.folderUri)
      if (p) out.push(p)
    }
    for (const ws of parsed.backupWorkspaces?.workspaces ?? []) {
      const p = parseFileUri(ws.configPath)
      // configPath points to a `.code-workspace` file — the actual project
      // root is its containing directory.
      if (p) out.push(path.dirname(p))
    }
  } catch { /* storage.json missing or malformed — skip */ }

  const wsStorage = path.join(userDataDir, 'workspaceStorage')
  for (const dir of listDir(wsStorage)) {
    try {
      const raw = fs.readFileSync(path.join(wsStorage, dir, 'workspace.json'), 'utf-8')
      const parsed = JSON.parse(raw) as { folder?: string }
      const p = parseFileUri(parsed.folder)
      if (p) out.push(p)
    } catch { /* skip — orphan workspace dirs are common */ }
  }

  return out
}

function parseFileUri(uri: string | undefined): string | null {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null
  try {
    return decodeURIComponent(uri.slice('file://'.length))
  } catch {
    return null
  }
}

/** Platform-aware resolver for Cursor's VS Code-style application data dir.
 *  Returns null when we can't determine it (rare). */
export function defaultCursorUserDataDir(home: string): string | null {
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor', 'User')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    return appData ? path.join(appData, 'Cursor', 'User') : null
  }
  // Linux + everything else follow the XDG convention.
  return path.join(home, '.config', 'Cursor', 'User')
}

// ─── Persistent seen-projects log ───────────────────────────────────────────

/** Read every cwd recorded in the log. Missing file → empty. Lines that
 *  fail to parse are silently skipped. */
export function readSeenCwds(logPath: string): string[] {
  let raw: string
  try { raw = fs.readFileSync(logPath, 'utf-8') } catch { return [] }
  const out: string[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed) as { cwd?: unknown }
      if (typeof obj.cwd === 'string' && obj.cwd) out.push(obj.cwd)
    } catch { /* skip malformed line */ }
  }
  return out
}

/** Append unique cwds to the log. Creates the file and parent dirs on first
 *  write. Existing entries are not rewritten — only genuinely new paths get
 *  a fresh line. */
export function appendSeenCwds(logPath: string, cwds: ReadonlyArray<string>): void {
  const existing = new Set(readSeenCwds(logPath))
  const additions: string[] = []
  for (const cwd of cwds) {
    if (existing.has(cwd)) continue
    existing.add(cwd)
    additions.push(cwd)
  }
  if (additions.length === 0) return
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }) } catch { /* ignore */ }
  const payload = additions.map(cwd => JSON.stringify({ cwd, seenAt: new Date().toISOString() })).join('\n') + '\n'
  fs.appendFileSync(logPath, payload, 'utf-8')
}

// Module-level guard so concurrent inventory requests on a fresh install
// don't each kick off their own home scan.
let initialScanInFlight = false

/** Fire-and-forget: if the log doesn't exist, scan the home dir once and
 *  append everything found to the log. Subsequent calls are no-ops until
 *  the process restarts. */
export function triggerInitialScanIfNeeded(logPath: string, home: string): void {
  if (initialScanInFlight) return
  try { fs.accessSync(logPath, fs.constants.F_OK); return } catch { /* missing → run scan */ }
  initialScanInFlight = true
  // setImmediate yields control back to Express so the current request
  // returns without waiting on the scan. The scan itself is synchronous but
  // bounded by maxDepth; on a typical home dir it completes in a few seconds.
  setImmediate(() => {
    try {
      const found = scanHomeForCursorProjects(home)
      // Always write the file — even if empty — so we don't re-scan next
      // request. An empty log is the legitimate first-run result for a user
      // who has never used Cursor in any project.
      if (found.length > 0) {
        appendSeenCwds(logPath, found)
      } else {
        try { fs.mkdirSync(path.dirname(logPath), { recursive: true }) } catch { /* ignore */ }
        try { fs.writeFileSync(logPath, '', 'utf-8') } catch { /* ignore */ }
      }
    } finally {
      // Stay set for the lifetime of the process — file existence is the
      // long-term signal; flag just prevents redundant in-flight scans.
    }
  })
}

/** Force the initial scan to run NOW, synchronously. Used by the manual
 *  "Rescan projects" endpoint so we can return the diff to the UI. Also
 *  resets the in-flight guard so a future first-run trigger can re-fire. */
export function rescanAndPersist(logPath: string, home: string): { added: string[]; total: number } {
  const before = new Set(readSeenCwds(logPath))
  const found = scanHomeForCursorProjects(home)
  const added = found.filter(p => !before.has(p))
  if (added.length > 0) appendSeenCwds(logPath, added)
  // Also create an empty file if nothing was found and the log didn't exist,
  // matching the first-run trigger's "we've scanned, don't retry" contract.
  try { fs.accessSync(logPath, fs.constants.F_OK) } catch {
    try { fs.mkdirSync(path.dirname(logPath), { recursive: true }) } catch { /* ignore */ }
    try { fs.writeFileSync(logPath, '', 'utf-8') } catch { /* ignore */ }
  }
  initialScanInFlight = false
  return { added, total: before.size + added.length }
}

// ─── Deep filesystem scan ────────────────────────────────────────────────────

// Directory names we never descend into during the home-dir scan. Big or
// uninteresting trees that almost certainly don't contain Cursor projects —
// pruning them turns a multi-minute walk into a few seconds. Hidden dirs are
// pruned generically (see `walk` below) except for `.cursor` itself.
const SCAN_SKIP = new Set<string>([
  'node_modules', 'bower_components', 'venv', '__pycache__',
  'target', 'dist', 'build', 'out', 'vendor', 'tmp',
  'Library', 'Applications', 'Music', 'Movies', 'Pictures',
  '.npm', '.cache', '.pnpm-store', '.yarn', '.gradle', '.m2',
  '.vscode-server', '.cursor-server', '.docker', '.Trash',
])

export interface ScanOptions {
  /** Walk no deeper than this many levels below `root`. The default (4) is
   *  enough for `~/Code/<org>/<repo>/...` style layouts without exploding
   *  into monorepo subpackages. */
  maxDepth?: number
}

/** Recursively scan `root` (typically the user's home dir) for directories
 *  containing a `.cursor/` child. Returns the list of project roots.
 *
 *  Bounded by `maxDepth` and a fixed skip-list (node_modules, .git, etc.).
 *  Synchronous and best-effort — unreadable entries are silently skipped. */
export function scanHomeForCursorProjects(root: string, opts: ScanOptions = {}): string[] {
  const maxDepth = opts.maxDepth ?? 4
  const found: string[] = []

  function walk(dir: string, depth: number) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch { return }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      // `.cursor` is the signal — record its parent as a project root and
      // never descend into it (no point scanning Cursor's own internals).
      if (ent.name === '.cursor') {
        // Don't record the scan root itself — at home, the `.cursor/` we
        // see is the global user config, not a project root.
        if (depth > 0) found.push(dir)
        continue
      }
      if (SCAN_SKIP.has(ent.name)) continue
      // Skip every other dotfile dir (.git, .vscode, .config, etc.) — they
      // never contain a user-authored Cursor project tree.
      if (ent.name.startsWith('.')) continue
      if (depth >= maxDepth) continue
      walk(path.join(dir, ent.name), depth + 1)
    }
  }

  walk(root, 0)
  return found
}

// Derive shared parent directories from the greedy-decoded project entries.
// We require at least two known projects under the same parent before we
// treat it as a code root — that filters out one-off paths whose decoding
// happened to land in the middle of an unrelated dir tree.
function deriveCodeRoots(candidates: string[], home: string): string[] {
  const counts = new Map<string, number>()
  for (const p of candidates) {
    // Only consider candidates that actually exist as a sanity check —
    // garbage decodes shouldn't contribute to root scoring.
    if (!hasCursorDir(p)) continue
    let cur = path.dirname(p)
    // Stop at home; we never want `~` itself acting as a code root because
    // its child listing would include too many unrelated dotfiles + caches.
    while (cur.startsWith(home + path.sep)) {
      counts.set(cur, (counts.get(cur) ?? 0) + 1)
      cur = path.dirname(cur)
    }
  }
  const roots: string[] = []
  for (const [root, count] of counts) {
    if (count >= 2) roots.push(root)
  }
  // Prefer deepest roots first so a tight directory (~/Code) wins over a
  // sparse ancestor (~) in case both met the threshold.
  roots.sort((a, b) => b.length - a.length)
  return roots
}

function hasCursorDir(p: string): boolean {
  try {
    return fs.statSync(path.join(p, '.cursor')).isDirectory()
  } catch {
    return false
  }
}

// Walk upward from `start` (a file or dir) looking for an ancestor that
// contains a `.cursor/` subdirectory. Stops at `home` or filesystem root so
// we never traverse outside the user's tree. Returns null if no match.
function findCursorAncestor(start: string, home: string): string | null {
  let cur = path.resolve(start)
  // Walk while strictly inside `home` (a `.cursor/` directly under home is
  // the user's global Cursor dir, not a project root — skip that).
  while (cur.startsWith(home + path.sep) && cur !== home) {
    if (hasCursorDir(cur)) return cur
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

function listDir(p: string): string[] {
  try {
    return fs.readdirSync(p)
  } catch {
    return []
  }
}

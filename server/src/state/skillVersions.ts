// Pre-image versioning for skill content. Every PATCH that rewrites a skill
// file calls snapshot() with the file's *current* contents before the write
// lands, giving the user a one-click rollback target. Storage lives next to
// the other loadoutsmith state so it follows the same backup/cleanup rhythm.

import fs from 'fs'
import os from 'os'
import path from 'path'

// Per-skill cap. Generous enough for "I broke it on the 5th edit" but small
// enough that a busy user editing the same skill 200 times doesn't gigabyte
// the loadoutsmith dir.
export const MAX_VERSIONS_PER_SKILL = 20

// Resolved lazily so tests can swap $HOME before the first call (matches the
// pattern used by superRouter/store.ts and other state modules).
function root(): string {
  return path.join(os.homedir(), '.loadoutsmith', 'skill-versions')
}

export interface VersionInfo {
  // ISO 8601 timestamp used as both the filename stem and the public id.
  // Filesystem-safe (colons are tolerated on macOS+Linux; on Windows we'd
  // need to escape, but the rest of the app already assumes a posix-style
  // home dir).
  timestamp: string
  sizeBytes: number
}

function dirFor(skillId: string): string {
  // skillId is already a base64 string (filesystem path encoded). Use it as
  // the directory name directly — no slashes, no traversal risk, stable across
  // skill renames (the id is keyed on path, so rename = new id = clean break).
  return path.join(root(), skillId)
}

function isoNow(): string {
  // Replace colons with `-` so the filename is safe on case-insensitive
  // platforms and easy to round-trip via path.basename. The ISO `T` separator
  // stays so it's still human-scannable.
  return new Date().toISOString().replace(/:/g, '-')
}

function listFilesSorted(dir: string): string[] {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .filter(name => name.endsWith('.md'))
    .sort() // ISO timestamps sort lexicographically ascending == chronologically
}

function trimToCap(dir: string): void {
  const files = listFilesSorted(dir)
  const overflow = files.length - MAX_VERSIONS_PER_SKILL
  if (overflow <= 0) return
  for (let i = 0; i < overflow; i++) {
    try { fs.unlinkSync(path.join(dir, files[i])) } catch { /* race or already gone */ }
  }
}

// Capture the current contents of `filePath` into the skill's version store.
// Called *before* a write — so the snapshot is the pre-image. Returns the
// version timestamp, or null if there was nothing to snapshot (file missing).
export function snapshot(skillId: string, filePath: string): string | null {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
  const dir = dirFor(skillId)
  fs.mkdirSync(dir, { recursive: true })
  const ts = isoNow()
  fs.writeFileSync(path.join(dir, `${ts}.md`), content)
  trimToCap(dir)
  return ts
}

export function listVersions(skillId: string): VersionInfo[] {
  const dir = dirFor(skillId)
  const files = listFilesSorted(dir)
  const out: VersionInfo[] = []
  for (const name of files) {
    const ts = name.slice(0, -3) // strip .md
    try {
      const stat = fs.statSync(path.join(dir, name))
      out.push({ timestamp: ts, sizeBytes: stat.size })
    } catch { /* race */ }
  }
  // Newest first for UI consumption.
  return out.reverse()
}

export function getVersionContent(skillId: string, timestamp: string): string | null {
  const file = path.join(dirFor(skillId), `${timestamp}.md`)
  // Defense in depth — make sure timestamp didn't include path separators.
  const resolved = path.resolve(file)
  const parent = path.resolve(dirFor(skillId))
  if (!resolved.startsWith(parent + path.sep)) return null
  try {
    return fs.readFileSync(resolved, 'utf-8')
  } catch {
    return null
  }
}

// Restoration: snapshot the current state (so the restore is itself
// reversible), then return the historical content for the caller to write
// back. The caller does the write because it owns the file-locking + symlink
// resolution logic for the actual skill path.
export interface RestoreResult {
  content: string
  preRestoreSnapshot: string | null
}

export function prepareRestore(
  skillId: string,
  timestamp: string,
  currentFilePath: string,
): RestoreResult | null {
  const content = getVersionContent(skillId, timestamp)
  if (content === null) return null
  const preRestoreSnapshot = snapshot(skillId, currentFilePath)
  return { content, preRestoreSnapshot }
}

export const __test = { dirFor }

import fs from 'fs'
import path from 'path'

/**
 * Atomic file write: stage the contents in a sibling temp file then rename
 * onto the target. A crash between open() and rename leaves the target
 * intact; a crash between rename and fsync still leaves a valid file
 * (either old or new, never a half-written truncation).
 *
 * Sibling-dir tmp keeps the rename on the same volume so it's actually
 * atomic — skill / baseline / version paths all live under $HOME, so the
 * same-volume invariant holds.
 *
 * Centralized in lib/ so every write path through the server gets the
 * same crash-safety. Earlier callers (parser/frontmatterWriter, super-router,
 * baselines, versions, rollback) each had their own ad-hoc implementations
 * — some atomic, some `fs.writeFileSync` direct (LOC-42).
 */
export function atomicWrite(filePath: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  const tmp = path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}`)
  fs.writeFileSync(tmp, content)
  try {
    fs.renameSync(tmp, filePath)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* swallow cleanup error */ }
    throw err
  }
}

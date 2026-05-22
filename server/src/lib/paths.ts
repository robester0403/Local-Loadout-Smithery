// Filesystem paths used across the server. Centralized so renames/migrations
// touch one file and so callers can't accidentally drift.

import os from 'os'
import path from 'path'

/** Root of all loadoutsmith-managed state on disk. */
export const LOADOUT_DIR = path.join(os.homedir(), '.loadoutsmith')

/** Append-only log of skill reclassify/move operations. */
export const MOVE_LOG_PATH = path.join(LOADOUT_DIR, 'move-log.jsonl')

/** Dedup-append log of every Cursor project cwd we've ever resolved. Acts as
 *  a "first-run scan completed" sentinel via file existence. */
export const CURSOR_SEEN_LOG_PATH = path.join(LOADOUT_DIR, 'cursor-projects-seen.jsonl')

/**
 * Throw a 403-shaped error if the resolved path escapes the user's home dir.
 * The home directory itself is permitted (some operations target ~/.claude).
 */
export function assertWithinHome(p: string): void {
  const home = os.homedir()
  const resolved = path.resolve(p)
  if (resolved !== home && !resolved.startsWith(home + path.sep)) {
    throw new HttpError(403, 'Path outside home directory')
  }
}

/**
 * Stricter guard for skill-id-derived paths. Skill IDs are user-supplied
 * (base64 of a path); without this, a request can hand us any path under
 * $HOME and any write route would happily clobber it (e.g. ~/.ssh/id_rsa).
 *
 * Accepts paths that live in one of the recognized loadout roots:
 *   - a `.claude` or `.claude-*` segment (Claude global or project)
 *   - a `.cursor` segment (Cursor global or project)
 *   - a `.codex` segment (Codex global)
 *   - basename `AGENTS.md` (Codex project — sits at <cwd>/AGENTS.md with no
 *     `.codex` ancestor; discovery finds these via session metadata)
 *   - a `.loadoutsmith` segment (uninstalled trash, baselines, versions)
 *
 * Still requires the path to be under $HOME via assertWithinHome.
 */
export function assertAllowedSkillPath(p: string): void {
  assertWithinHome(p)
  const resolved = path.resolve(p)
  const segments = resolved.split(path.sep)
  const allowed =
    segments.some(s => s === '.claude' || s.startsWith('.claude-')) ||
    segments.some(s => s === '.cursor') ||
    segments.some(s => s === '.codex') ||
    segments.some(s => s === '.loadoutsmith') ||
    path.basename(resolved) === 'AGENTS.md'
  if (!allowed) {
    throw new HttpError(403, 'Path not in an allowed loadout root')
  }
}

/**
 * Lightweight HTTP-status-bearing error class. Thrown by route handlers and
 * caught by the asyncHandler / global error middleware to map status correctly.
 */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

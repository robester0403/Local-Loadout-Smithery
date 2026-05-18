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
 * Lightweight HTTP-status-bearing error class. Thrown by route handlers and
 * caught by the asyncHandler / global error middleware to map status correctly.
 */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

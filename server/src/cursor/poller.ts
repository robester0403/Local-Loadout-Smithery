// Watcher + backup timer that snapshots Cursor's recently-used lists and
// appends activation events to the local JSONL log.
//
// Strategy: fs.watch on state.vscdb is the primary trigger — captures every
// SQLite write at the moment it happens, so we don't miss activations
// regardless of polling interval. The 60s timer is a backup in case the
// watcher misses an event (fs.watch on macOS is occasionally flaky on
// SQLite WAL writes; the timer makes that recoverable).
//
// Debounce: a single Cursor write can produce multiple fs events in quick
// succession (WAL + main DB + journal). We coalesce within 300ms.

import fs from 'fs'
import path from 'path'
import { CURSOR_DB_PATH, isCursorDatabaseAvailable } from './db'
import {
  appendEvents,
  diffSnapshots,
  readRecentSnapshot,
  type CursorRecentSnapshot,
} from './recent'

const DEBOUNCE_MS = 300
const BACKUP_INTERVAL_MS = 60_000

interface PollerState {
  lastSnapshot: CursorRecentSnapshot | null
  watcher: fs.FSWatcher | null
  backupTimer: NodeJS.Timeout | null
  debounceTimer: NodeJS.Timeout | null
}

const state: PollerState = {
  lastSnapshot: null,
  watcher: null,
  backupTimer: null,
  debounceTimer: null,
}

function takeSnapshotAndAppend(): void {
  try {
    const next = readRecentSnapshot()
    const events = diffSnapshots(state.lastSnapshot, next)
    if (events.length > 0) appendEvents(events)
    state.lastSnapshot = next
  } catch (err) {
    // Don't crash the server if a single read fails — log and continue.
    console.warn('[cursor-poller] snapshot read failed:', (err as Error).message)
  }
}

function scheduleDebouncedSnapshot(): void {
  if (state.debounceTimer) clearTimeout(state.debounceTimer)
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null
    takeSnapshotAndAppend()
  }, DEBOUNCE_MS)
}

/**
 * Start the poller. Idempotent — if already running, this is a no-op.
 * Returns true if a watcher was started, false if Cursor isn't installed.
 */
export function startCursorPoller(): boolean {
  if (state.watcher || state.backupTimer) return true
  if (!isCursorDatabaseAvailable()) return false

  // Initial snapshot. We don't generate events from this one — we just
  // baseline against current state so the first real activation produces
  // a clean diff.
  state.lastSnapshot = readRecentSnapshot()

  // fs.watch on macOS works on the file itself; we watch the parent dir
  // because SQLite WAL mode can briefly remove the main file during
  // checkpoints, which would invalidate a direct file watch.
  const dir = path.dirname(CURSOR_DB_PATH)
  const dbBasename = path.basename(CURSOR_DB_PATH)

  state.watcher = fs.watch(dir, (_event, filename) => {
    if (!filename) return
    // We care about state.vscdb and its WAL/journal companions.
    if (filename === dbBasename || filename.startsWith(`${dbBasename}-`)) {
      scheduleDebouncedSnapshot()
    }
  })
  // Watcher errors shouldn't crash the server.
  state.watcher.on('error', err => {
    console.warn('[cursor-poller] watcher error:', err.message)
  })

  // Backup timer in case the watcher misses (fs.watch is best-effort).
  state.backupTimer = setInterval(takeSnapshotAndAppend, BACKUP_INTERVAL_MS)
  // Don't keep the process alive just for this timer.
  state.backupTimer.unref()

  return true
}

export function stopCursorPoller(): void {
  if (state.watcher) {
    state.watcher.close()
    state.watcher = null
  }
  if (state.backupTimer) {
    clearInterval(state.backupTimer)
    state.backupTimer = null
  }
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer)
    state.debounceTimer = null
  }
  state.lastSnapshot = null
}

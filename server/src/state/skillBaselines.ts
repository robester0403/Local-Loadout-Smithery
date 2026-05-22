// Per-skill "last known content" baselines. Lets us detect shadow edits —
// changes the user makes to a skill file outside this app (in their editor,
// via another tool, by a git pull) — so the inventory can flag them instead
// of silently presenting stale content.
//
// Distinct from LOC-21's skill version history:
//   - skill-versions/  = OUR edit history (pre-image before every PATCH).
//   - skill-baselines/ = "what we last observed", regardless of who wrote it.
// Both files live under ~/.loadoutsmith and are content-only, so they work
// uniformly across Claude / Cursor / Codex skills.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { atomicWrite } from '../lib/atomicWrite'

function root(): string {
  return path.join(os.homedir(), '.loadoutsmith', 'skill-baselines')
}

function fileFor(skillId: string): string {
  // skillId is base64-encoded already — safe as a filename, stable across
  // renames (rename = new path = new id, which is a clean break).
  return path.join(root(), `${skillId}.md`)
}

export interface Baseline {
  content: string
  observedAt: string // ISO timestamp
}

export function getBaseline(skillId: string): Baseline | null {
  const file = fileFor(skillId)
  try {
    const content = fs.readFileSync(file, 'utf-8')
    const stat = fs.statSync(file)
    return { content, observedAt: stat.mtime.toISOString() }
  } catch {
    return null
  }
}

export function writeBaseline(skillId: string, content: string): void {
  // Atomic write so a crash mid-flight can't leave a truncated baseline
  // file — a truncated baseline would make every subsequent scan flag
  // the skill as shadow-edited until the user re-accepts (LOC-42).
  atomicWrite(fileFor(skillId), content)
}

export type DiffKind = 'unchanged' | 'first-seen' | 'shadow-edit'

export interface DiffResult {
  kind: DiffKind
  // Small one-line summary for the UI. Computed cheaply (line count delta,
  // first-changed-line) — not a full diff. The drawer can show this without
  // shipping a diff library to the client.
  summary?: string
}

function shortSummary(prev: string, next: string): string {
  const prevLines = prev.split('\n')
  const nextLines = next.split('\n')
  const lineDelta = nextLines.length - prevLines.length
  let firstDiffLine = -1
  const min = Math.min(prevLines.length, nextLines.length)
  for (let i = 0; i < min; i++) {
    if (prevLines[i] !== nextLines[i]) {
      firstDiffLine = i + 1 // 1-indexed for the UI
      break
    }
  }
  if (firstDiffLine === -1 && lineDelta !== 0) firstDiffLine = min + 1
  const deltaText = lineDelta === 0
    ? 'same line count'
    : lineDelta > 0
      ? `+${lineDelta} line${lineDelta === 1 ? '' : 's'}`
      : `${lineDelta} line${lineDelta === -1 ? '' : 's'}`
  return firstDiffLine === -1
    ? `Content differs (${deltaText})`
    : `First change at line ${firstDiffLine} (${deltaText})`
}

export function diffAgainstBaseline(skillId: string, currentContent: string): DiffResult {
  const baseline = getBaseline(skillId)
  if (baseline === null) return { kind: 'first-seen' }
  if (baseline.content === currentContent) return { kind: 'unchanged' }
  return { kind: 'shadow-edit', summary: shortSummary(baseline.content, currentContent) }
}

// Reconciliation helper used by discovery: compute the diff, and for
// first-seen skills auto-write the baseline (we can't retroactively know
// pre-LSM history). For shadow edits, do NOT auto-update — the user must
// explicitly accept via the UI.
export function reconcileBaseline(skillId: string, currentContent: string): DiffResult {
  const result = diffAgainstBaseline(skillId, currentContent)
  if (result.kind === 'first-seen') {
    writeBaseline(skillId, currentContent)
  }
  return result
}

export const __test = { fileFor }

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
  return path.join(root(), `${skillId}.json`)
}

interface StoredBaseline {
  body: string
  frontmatter: Record<string, unknown>
}

export interface Baseline {
  body: string
  frontmatter: Record<string, unknown>
  observedAt: string
}

export interface FrontmatterChange {
  key: string
  before: unknown
  after: unknown
}

export function getBaseline(skillId: string): Baseline | null {
  const file = fileFor(skillId)
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const stat = fs.statSync(file)
    const stored = JSON.parse(raw) as StoredBaseline
    return {
      body: stored.body ?? '',
      frontmatter: stored.frontmatter ?? {},
      observedAt: stat.mtime.toISOString(),
    }
  } catch {
    return null
  }
}

export function writeBaseline(
  skillId: string,
  body: string,
  frontmatter: Record<string, unknown> = {},
): void {
  const stored: StoredBaseline = { body, frontmatter }
  atomicWrite(fileFor(skillId), JSON.stringify(stored))
}

export type DiffKind = 'unchanged' | 'first-seen' | 'shadow-edit'

export interface DiffResult {
  kind: DiffKind
  // One-line summary for inline display in the health issue message.
  summary?: string
  // Detailed diff for the diff modal — only present when kind === 'shadow-edit'.
  frontmatterChanges?: FrontmatterChange[]
  bodyBefore?: string
  bodyAfter?: string
}

function computeFrontmatterChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FrontmatterChange[] {
  const changes: FrontmatterChange[] = []
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of allKeys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changes.push({ key, before: before[key], after: after[key] })
    }
  }
  return changes
}

function shortBodySummary(prev: string, next: string): string {
  const prevLines = prev.split('\n')
  const nextLines = next.split('\n')
  const lineDelta = nextLines.length - prevLines.length
  let firstDiffLine = -1
  const min = Math.min(prevLines.length, nextLines.length)
  for (let i = 0; i < min; i++) {
    if (prevLines[i] !== nextLines[i]) {
      firstDiffLine = i + 1
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

export function diffAgainstBaseline(
  skillId: string,
  currentBody: string,
  currentFrontmatter: Record<string, unknown> = {},
): DiffResult {
  const baseline = getBaseline(skillId)
  if (baseline === null) return { kind: 'first-seen' }

  const fmChanges = computeFrontmatterChanges(baseline.frontmatter, currentFrontmatter)
  const bodyChanged = baseline.body !== currentBody

  if (fmChanges.length === 0 && !bodyChanged) return { kind: 'unchanged' }

  const changedKeys = fmChanges.map(c => c.key)
  let summary: string
  if (fmChanges.length > 0 && !bodyChanged) {
    summary = `Frontmatter changed: ${changedKeys.join(', ')}`
  } else if (fmChanges.length === 0 && bodyChanged) {
    summary = shortBodySummary(baseline.body, currentBody)
  } else {
    summary = `Frontmatter (${changedKeys.join(', ')}) and body changed`
  }

  return {
    kind: 'shadow-edit',
    summary,
    frontmatterChanges: fmChanges.length > 0 ? fmChanges : undefined,
    bodyBefore: bodyChanged ? baseline.body : undefined,
    bodyAfter: bodyChanged ? currentBody : undefined,
  }
}

// Reconciliation helper used by discovery: compute the diff, and for
// first-seen skills auto-write the baseline (we can't retroactively know
// pre-LSM history). For shadow edits, do NOT auto-update — the user must
// explicitly accept via the UI.
export function reconcileBaseline(
  skillId: string,
  currentBody: string,
  currentFrontmatter: Record<string, unknown> = {},
): DiffResult {
  const result = diffAgainstBaseline(skillId, currentBody, currentFrontmatter)
  if (result.kind === 'first-seen') {
    writeBaseline(skillId, currentBody, currentFrontmatter)
  }
  return result
}

export const __test = { fileFor }

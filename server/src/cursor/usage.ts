// Per-skill usage rollup for Cursor activations. Cursor's local SQLite
// stopped carrying authoritative cost data after ~2026-02-24 (composerData
// .usageData is empty in newer sessions), so we surface what's reliably
// extractable: activation count, distinct-session reach, and last-invoked
// timestamp.
//
// This module is the source of truth for the /api/cursor/usage route. The
// diagnostic script under server/scripts/ uses it too — single
// implementation, no duplication.

import { extractSkillName } from './attribution'
import { type CursorBubble, isCursorDatabaseAvailable, readSkillReadingBubbles } from './db'

export interface CursorSkillUsage {
  /** Skill name as it appears in the directory layout. */
  skill: string
  /** Total times we observed the agent loading this skill. */
  activations: number
  /** Number of distinct composers (chat sessions) that activated this skill. */
  sessions: number
  /** ms epoch of the most recent activation; 0 if no timestamp available. */
  lastInvoked: number
}

export interface CursorUsageReport {
  /** True when the Cursor SQLite is on disk; false otherwise. */
  available: boolean
  /** Per-skill rollup, sorted by activation count descending. */
  skills: CursorSkillUsage[]
  /** Total activations across all skills (= sum of skills[].activations). */
  totalActivations: number
  /** Distinct composers across all activations. */
  distinctSessions: number
}

/** Compute the rollup directly from already-read bubbles. Useful for tests. */
export function rollupUsage(bubbles: CursorBubble[]): CursorUsageReport {
  const tally = new Map<string, {
    skill: string
    activations: number
    composers: Set<string>
    lastInvoked: number
  }>()
  const allComposers = new Set<string>()

  for (const b of bubbles) {
    if (b.type !== 2 || !b.toolFormerData) continue
    const skill = extractSkillName(b.toolFormerData)
    if (!skill) continue

    const entry = tally.get(skill) ?? {
      skill, activations: 0, composers: new Set<string>(), lastInvoked: 0,
    }
    entry.activations += 1
    entry.composers.add(b.composerId)
    if (b.createdAt > entry.lastInvoked) entry.lastInvoked = b.createdAt
    tally.set(skill, entry)

    allComposers.add(b.composerId)
  }

  const skills: CursorSkillUsage[] = Array.from(tally.values())
    .map(e => ({
      skill: e.skill,
      activations: e.activations,
      sessions: e.composers.size,
      lastInvoked: e.lastInvoked,
    }))
    // Most-active first; tiebreak by recency.
    .sort((a, b) => b.activations - a.activations || b.lastInvoked - a.lastInvoked)

  return {
    available: true,
    skills,
    totalActivations: skills.reduce((sum, s) => sum + s.activations, 0),
    distinctSessions: allComposers.size,
  }
}

/**
 * End-to-end rollup. Returns an `available: false` report (with empty
 * skills array) when Cursor isn't installed on the host, so callers can
 * differentiate "no data yet" from "feature unavailable".
 */
export function computeCursorSkillUsage(): CursorUsageReport {
  if (!isCursorDatabaseAvailable()) {
    return { available: false, skills: [], totalActivations: 0, distinctSessions: 0 }
  }
  return rollupUsage(readSkillReadingBubbles())
}

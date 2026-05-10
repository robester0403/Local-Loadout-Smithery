// Per-skill usage rollup for Cursor activations.
//
// Cursor's local persistence is being phased out:
//   - composerData.usageData (per-session billing) emptied around Feb 2026
//   - bubble.tokenCount populated 0% of recent bubbles
//   - bubble persistence itself: 81% of Jan 2026 composers, 0% of May 2026
//     (last persisted bubble observed: 2026-05-06)
//
// What remains reliably extractable on the historical window is activation
// signal: which skill was loaded, when, in which composer. That's what this
// module returns — bounded by the persistence window, not live for new
// sessions. For current per-skill cost characterization see the static
// bodyTokens/listingTokens fields populated by the scanner instead.
//
// Source of truth for the /api/cursor/usage route; also used by the
// diagnostic CLI under server/scripts/.

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

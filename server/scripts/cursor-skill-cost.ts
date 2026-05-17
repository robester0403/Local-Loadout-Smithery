#!/usr/bin/env tsx
// Per-skill activation report for Cursor. Pretty-prints the same data the
// /api/cursor/usage route returns; uses the same modules so there's no
// duplicated extraction logic.
//
//   tsx server/scripts/cursor-skill-cost.ts
//
// Why no dollar cost column:
//   Cursor's local persistence is fading. composerData.usageData (per-session
//   billing) emptied ~Feb 2026; bubble.tokenCount went to zero on recent
//   sessions; bubble persistence itself dropped from 81% (Jan 2026) to 0%
//   (May 2026). Last persisted bubble: 2026-05-06. Cursor 2.0 moved
//   conversation state server-side as a base64 token clients can't
//   reconstruct (see Cursor forum threads on conversationState corruption).
//
//   Per-skill dollar cost is therefore not extractable from current local
//   data. Activation volume on the historical window is — that's what this
//   report shows. For per-skill cost characterization see the static
//   bodyTokens/listingTokens fields rendered in the LSM Cursor tab.

import { computeCursorSkillUsage } from '../src/cursor/usage'

function fmtRelativeDate(ms: number): string {
  if (!ms) return '—'
  const days = Math.floor((Date.now() - ms) / 86_400_000)
  if (days < 0) return 'future'
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

function main(): void {
  const report = computeCursorSkillUsage()
  if (!report.available) {
    console.log('Cursor SQLite not found on this host.')
    return
  }

  console.log(`Total activations:        ${report.totalActivations}`)
  console.log(`Distinct skills:          ${report.skills.length}`)
  console.log(`Distinct composers:       ${report.distinctSessions}`)
  console.log('')

  if (report.skills.length === 0) {
    console.log('No skill activations found.')
    return
  }

  const w = (s: string, n: number) => s.padEnd(n)
  console.log(
    w('SKILL', 38) +
    w('ACTIVATIONS', 14) +
    w('SESSIONS', 12) +
    'LAST INVOKED',
  )
  console.log('─'.repeat(82))
  for (const s of report.skills) {
    console.log(
      w(s.skill, 38) +
      w(String(s.activations), 14) +
      w(String(s.sessions), 12) +
      fmtRelativeDate(s.lastInvoked),
    )
  }
}

main()

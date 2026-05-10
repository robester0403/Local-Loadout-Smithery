#!/usr/bin/env tsx
// Per-skill activation report for Cursor. Pretty-prints the same data the
// /api/cursor/usage route returns; uses the same modules so there's no
// duplicated extraction logic.
//
//   tsx server/scripts/cursor-skill-cost.ts
//
// Why no dollar cost column:
//   We investigated three potential cost sources in Cursor's local SQLite:
//     1. bubble.tokenCount.{input,output}Tokens — populated only on the
//        head assistant bubble per request (~1,771 of ~40k bubbles), and
//        never on tool-call bubbles. In observed data, the composers that
//        contain skill activations have token counts of zero on every
//        bubble.
//     2. composerData.usageData — { [model]: { costInCents, amount } }.
//        Cursor's billing rollup. Populated for 174/370 composers in the
//        test data, but ALL cost-bearing composers are from before
//        2026-02-24. Cursor stopped writing this field in newer sessions
//        — billing now lives server-side, inaccessible without an API.
//     3. ItemTable rolling lists (cursor.skills.recentlyUsed etc.) — no
//        timestamps, no per-session attribution, no cost.
//   Conclusion: per-skill dollar cost is not extractable from current
//   Cursor local data. Activation volume is.

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

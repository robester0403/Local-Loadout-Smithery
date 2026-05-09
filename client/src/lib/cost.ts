// Cost-axis derivation, insight tagging, sort ordering, and money formatting.
// Pure functions only — no React, no fetch. Tested via the components that
// consume them.

import type { Insight, MCPRow, Skill, SkillUsageSummary } from '../types'

// ─── Thresholds ──────────────────────────────────────────────────────────────
//
// Tuned empirically against ~150 skills. If we ever expose user-configurable
// thresholds, this is the file that becomes the default-source.

/** Skills above this loaded-cost threshold are eligible for the "winner" /
 *  "removal candidate" insights. Below it, loaded cost is too small to matter. */
export const LOADED_HIGH_USD = 0.001

/** Below this active-cost threshold we treat a skill as "no active usage"
 *  (the residual is float noise from the breakdown calculation). */
export const ACTIVE_HIGH_USD = 0.0001

/** A skill not invoked in this many days is flagged as dormant. */
export const DORMANT_DAYS = 90

/** Skills modified within this window are exempt from the
 *  removal-candidate flag — they may simply not have had a chance to be used yet. */
export const GRACE_PERIOD_DAYS = 10

const MS_PER_DAY = 86_400_000

// ─── Sort orderings ──────────────────────────────────────────────────────────

export const HEALTH_ORDER: Record<string, number> = { error: 0, warn: 1, ok: 2 }

/** Lower = higher priority in the inventory sort. */
export const INSIGHT_RANK = (s: Skill): number =>
  s.insight === 'removal-candidate' ? 0
  : s.dormant ? 1
  : s.insight === 'winner' ? 2
  : 3

// ─── MCP coercion ────────────────────────────────────────────────────────────

const MCP_STATUS_MAP: Record<MCPRow['status'], Skill['health']['status']> = {
  ok: 'ok',
  unavailable: 'error',
  unknown: 'warn',
}

/** Adapt an MCPRow into the Skill shape so the inventory table can render
 *  it alongside skills/commands/subagents without branching at every column. */
export function toMCPSkill(entry: MCPRow, usage?: { dollars: number; lastInvoked: string }): Skill {
  const toolCount = entry.tools.length
  const transport = entry.transport ?? 'stdio'
  const dormant = isDormant(usage?.lastInvoked)
  return {
    id: `mcp::${entry.name}`,
    name: entry.name,
    description: `${toolCount} tool${toolCount !== 1 ? 's' : ''} · ${transport}`,
    version: '',
    type: 'mcp',
    scope: entry.scope ?? 'global',
    account: '',
    path: entry.source ?? '',
    realpath: entry.source ?? '',
    isSymlink: false,
    body: '',
    frontmatter: {},
    lastModified: '',
    health: {
      status: MCP_STATUS_MAP[entry.status],
      issues: entry.statusReason
        ? [{
            severity: entry.status === 'unavailable' ? 'error' : 'warn',
            message: entry.statusReason,
          }]
        : [],
    },
    disabled: false,
    references: [],
    activeDollars: usage?.dollars ?? 0,
    loadedDollars: 0,
    totalDollars: usage?.dollars ?? 0,
    insight: null,
    dormant,
    lastInvoked: usage?.lastInvoked ?? '',
    bloat: false,
    descLen: 0,
    mcpData: entry,
  }
}

// ─── Cost merge ──────────────────────────────────────────────────────────────

/** Decorate raw skills with computed cost columns and derived insights from
 *  the usage summaries the server returns. */
export function mergeWithCost(skills: Skill[], summaries: SkillUsageSummary[]): Skill[] {
  const costMap = new Map(summaries.map(s => [s.skillName, s]))
  return skills.map(s => {
    const c = costMap.get(s.name)
    const activeDollars = c?.active.dollars ?? 0
    const loadedDollars = c?.loaded.dollars ?? 0
    const totalDollars = c?.total.dollars ?? 0
    const lastInvoked = c?.lastInvoked ?? ''

    const descLen = s.description.length
    const bloat = s.type !== 'command' && descLen > 150

    return {
      ...s,
      activeDollars,
      loadedDollars,
      totalDollars,
      insight: classifyInsight(s.lastModified, activeDollars, loadedDollars),
      dormant: isDormant(lastInvoked),
      lastInvoked,
      bloat,
      descLen,
    }
  })
}

function classifyInsight(
  lastModifiedIso: string,
  activeDollars: number,
  loadedDollars: number,
): Insight {
  if (loadedDollars < LOADED_HIGH_USD) return null
  if (activeDollars >= ACTIVE_HIGH_USD) return 'winner'
  if (isWithinGracePeriod(lastModifiedIso)) return null
  return 'removal-candidate'
}

function isWithinGracePeriod(lastModifiedIso: string): boolean {
  if (!lastModifiedIso) return false
  const t = new Date(lastModifiedIso).getTime()
  if (Number.isNaN(t)) return false
  return (Date.now() - t) / MS_PER_DAY < GRACE_PERIOD_DAYS
}

function isDormant(lastInvokedIso: string | undefined): boolean {
  if (!lastInvokedIso) return false
  const t = new Date(lastInvokedIso).getTime()
  if (Number.isNaN(t)) return false
  return (Date.now() - t) / MS_PER_DAY > DORMANT_DAYS
}

// ─── Aggregate helpers ───────────────────────────────────────────────────────

export interface InventoryTotals {
  active: number
  loaded: number
  total: number
}

export function computeTotals(skills: Skill[]): InventoryTotals {
  let active = 0
  let loaded = 0
  for (const s of skills) {
    active += s.activeDollars
    loaded += s.loadedDollars
  }
  return { active, loaded, total: active + loaded }
}

export interface ReviewCounts {
  removal: number
  dormant: number
  total: number
}

export function countReview(skills: Skill[]): ReviewCounts {
  let removal = 0
  let dormant = 0
  for (const s of skills) {
    if (s.insight === 'removal-candidate') removal++
    else if (s.dormant) dormant++
  }
  return { removal, dormant, total: removal + dormant }
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/** Display-only money formatter for the header / totals row. Uses 2 decimals
 *  for ≥$0.01, 4 decimals for smaller positives, and a stable "$0.00" for zero. */
export function fmtUsd(n: number): string {
  if (n >= 0.01) return `$${n.toFixed(2)}`
  if (n > 0) return `$${n.toFixed(4)}`
  return '$0.00'
}

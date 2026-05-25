// Cost-axis derivation, insight tagging, sort ordering, and money formatting.
// Pure functions only — no React, no fetch. Tested via the components that
// consume them.

import type { Insight, MCPRow, Skill, SkillUsageSummary } from '../types'

// ─── Thresholds ──────────────────────────────────────────────────────────────
//
// Tuned empirically against ~150 skills. These are defaults — the user can
// override any of them through the sidebar Settings panel; see
// `lib/settings.ts` for persistence and `mergeWithCost(..., thresholds)` for
// the injection point.

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

/** Skills with description length above this cap are flagged as bloat
 *  (commands are exempt because slash commands often need richer descriptions). */
export const DESC_BLOAT_CHARS = 150

/** All tunable thresholds in one bag so callers can pass overrides without
 *  juggling argument order. Every field is optional; missing fields fall back
 *  to the module-level constants above. */
export interface CostThresholds {
  loadedHighUsd?: number
  activeHighUsd?: number
  dormantDays?: number
  gracePeriodDays?: number
  descBloatChars?: number
}

export interface ResolvedThresholds {
  loadedHighUsd: number
  activeHighUsd: number
  dormantDays: number
  gracePeriodDays: number
  descBloatChars: number
}

export const DEFAULT_THRESHOLDS: ResolvedThresholds = {
  loadedHighUsd: LOADED_HIGH_USD,
  activeHighUsd: ACTIVE_HIGH_USD,
  dormantDays: DORMANT_DAYS,
  gracePeriodDays: GRACE_PERIOD_DAYS,
  descBloatChars: DESC_BLOAT_CHARS,
}

export function resolveThresholds(t?: CostThresholds): ResolvedThresholds {
  if (!t) return DEFAULT_THRESHOLDS
  return {
    loadedHighUsd: t.loadedHighUsd ?? DEFAULT_THRESHOLDS.loadedHighUsd,
    activeHighUsd: t.activeHighUsd ?? DEFAULT_THRESHOLDS.activeHighUsd,
    dormantDays: t.dormantDays ?? DEFAULT_THRESHOLDS.dormantDays,
    gracePeriodDays: t.gracePeriodDays ?? DEFAULT_THRESHOLDS.gracePeriodDays,
    descBloatChars: t.descBloatChars ?? DEFAULT_THRESHOLDS.descBloatChars,
  }
}

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
export function toMCPSkill(
  entry: MCPRow,
  usage?: { dollars: number; lastInvoked: string; invocations?: number },
  thresholds?: CostThresholds,
): Skill {
  const t = resolveThresholds(thresholds)
  const toolCount = entry.tools.length
  const transport = entry.transport ?? 'stdio'
  const dormant = isDormant(usage?.lastInvoked, t.dormantDays)
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
    diagnostics: [],
    activeDollars: usage?.dollars ?? 0,
    loadedDollars: 0,
    totalDollars: usage?.dollars ?? 0,
    activeTokens: 0,
    loadedTokens: 0,
    invocations: usage?.invocations ?? 0,
    insight: null,
    dormant,
    lastInvoked: usage?.lastInvoked ?? '',
    bloat: false,
    descLen: 0,
    mcpData: entry,
  }
}

// ─── Cost merge ──────────────────────────────────────────────────────────────

/**
 * Decorate raw skills with computed cost columns and derived insights from
 * the usage summaries the server returns.
 *
 * Cost summaries from /api/usage/aggregate are computed exclusively from
 * Claude Code session logs under the user's ~/.claude projects directory —
 * Cursor skills never appear in those logs. Without the account guard a Cursor skill named
 * `morning-plan` would falsely inherit the Claude Code `morning-plan`'s cost
 * data because the join key was just the skill name.
 */
export function mergeWithCost(
  skills: Skill[],
  summaries: SkillUsageSummary[],
  thresholds?: CostThresholds,
): Skill[] {
  const t = resolveThresholds(thresholds)
  const costMap = new Map(summaries.map(s => [s.skillName, s]))
  return skills.map(s => {
    // Cursor skills have no Claude Code cost data — skip the lookup so we
    // don't shadow them with an identically-named Claude Code skill's cost.
    const c = s.account === 'cursor' ? undefined : costMap.get(s.name)
    const activeDollars = c?.active.dollars ?? 0
    const loadedDollars = c?.loaded.dollars ?? 0
    const totalDollars = c?.total.dollars ?? 0
    const activeTokens = c?.active.tokens ?? 0
    const loadedTokens = c?.loaded.tokens ?? 0
    const invocations = c?.invocations ?? 0
    const lastInvoked = c?.lastInvoked ?? ''

    const descLen = s.description.length
    const bloat = s.type !== 'command' && descLen > t.descBloatChars

    return {
      ...s,
      activeDollars,
      loadedDollars,
      totalDollars,
      activeTokens,
      loadedTokens,
      invocations,
      insight: classifyInsight(s.lastModified, activeDollars, loadedDollars, t, DEFAULT_CLASSIFICATION_FLAGS),
      dormant: isDormant(lastInvoked, t.dormantDays),
      lastInvoked,
      bloat,
      descLen,
    }
  })
}

/** Subset of the Settings.flags shape that this module needs to consult.
 *  Inlined to keep cost.ts free of a runtime import from settings.ts (which
 *  imports DEFAULT_THRESHOLDS from here — would be a cycle). */
export interface ClassificationFlags {
  removal: boolean
  winner: boolean
  dormant: boolean
  bloat: boolean
}

const DEFAULT_CLASSIFICATION_FLAGS: ClassificationFlags = {
  removal: true,
  winner: true,
  dormant: true,
  bloat: true,
}

/**
 * Re-derive the threshold-dependent fields (`insight`, `dormant`, `bloat`,
 * `descLen`) on an already-merged skill array without re-fetching usage
 * summaries from the server. Used when the user tweaks thresholds or flags
 * in the Settings modal — those should reclassify instantly, not trigger a
 * full inventory reload with spinner flicker.
 *
 * Flags act as classification gates: when `flags.removal` is false, no skill
 * is ever tagged 'removal-candidate'; same for 'winner', 'dormant', 'bloat'.
 * This keeps the downstream filter / banner / sort logic flag-agnostic —
 * disabled identifiers simply don't exist in the view.
 */
export function reapplyThresholds(
  skills: Skill[],
  thresholds?: CostThresholds,
  flags: ClassificationFlags = DEFAULT_CLASSIFICATION_FLAGS,
): Skill[] {
  const t = resolveThresholds(thresholds)
  return skills.map(s => {
    const descLen = s.description.length
    const bloat = flags.bloat && s.type !== 'command' && descLen > t.descBloatChars
    return {
      ...s,
      descLen,
      bloat,
      insight: classifyInsight(s.lastModified, s.activeDollars, s.loadedDollars, t, flags),
      dormant: flags.dormant && isDormant(s.lastInvoked, t.dormantDays),
    }
  })
}

function classifyInsight(
  lastModifiedIso: string,
  activeDollars: number,
  loadedDollars: number,
  t: ResolvedThresholds,
  flags: ClassificationFlags,
): Insight {
  if (loadedDollars < t.loadedHighUsd) return null
  if (activeDollars >= t.activeHighUsd) return flags.winner ? 'winner' : null
  if (isWithinGracePeriod(lastModifiedIso, t.gracePeriodDays)) return null
  return flags.removal ? 'removal-candidate' : null
}

function isWithinGracePeriod(lastModifiedIso: string, graceDays: number): boolean {
  if (!lastModifiedIso) return false
  const t = new Date(lastModifiedIso).getTime()
  if (Number.isNaN(t)) return false
  return (Date.now() - t) / MS_PER_DAY < graceDays
}

function isDormant(lastInvokedIso: string | undefined, dormantDays: number): boolean {
  if (!lastInvokedIso) return false
  const t = new Date(lastInvokedIso).getTime()
  if (Number.isNaN(t)) return false
  return (Date.now() - t) / MS_PER_DAY > dormantDays
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

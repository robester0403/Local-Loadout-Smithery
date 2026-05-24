// Phase 5 (LOC-77): type-specific ranking. Per arXiv 2502.17321 + SkillsBench:
// each artifact kind has a different value model, so a single one-size-fits-all
// ranker would either underweight personalization (which is the high-value
// signal in software engineering) or over-promote noisy candidates.
//
// All candidates flow through one `rankCandidates` call. The output is the
// same shape with `score` populated and capped to `topK` per kind.

import type { Candidate } from '../types'
import type { IntentCluster, ConversationSummary } from './types'
import type { GeneratedCandidate as CommandGenerated } from './detectors/commands'

export type GeneratedCandidate = CommandGenerated

const DEFAULT_TOP_K = 10

export interface RankOptions {
  /** Cap on candidates per kind. Default 10. */
  topK?: number
  clustersById?: Map<string, IntentCluster>
  summariesByArc?: Map<string, ConversationSummary>
  /** Names of skills the user already has installed (existing + accepted).
   *  Boosts subagents that orchestrate familiar skills. */
  existingSkillNames?: Set<string>
  /** Wallclock for recency math (ms epoch). Defaults to Date.now() at call time. */
  nowMs?: number
}

export function rankCandidates(
  candidates: GeneratedCandidate[],
  opts: RankOptions = {},
): GeneratedCandidate[] {
  const topK = opts.topK ?? DEFAULT_TOP_K
  const now = opts.nowMs ?? Date.now()

  const scored = candidates.map(c => ({ ...c, score: scoreOne(c, now, opts) }))

  const byKind = new Map<string, GeneratedCandidate[]>()
  for (const c of scored) {
    const arr = byKind.get(c.suggestedType) ?? []
    arr.push(c)
    byKind.set(c.suggestedType, arr)
  }

  const out: GeneratedCandidate[] = []
  for (const arr of byKind.values()) {
    arr.sort((a, b) => b.score - a.score)
    out.push(...arr.slice(0, topK))
  }
  return out
}

// ---- Per-kind scoring -------------------------------------------------------

function scoreOne(c: GeneratedCandidate, nowMs: number, opts: RankOptions): number {
  switch (c.suggestedType) {
    case 'skill':    return scoreSkill(c, nowMs, opts)
    case 'command':  return scoreCommand(c, nowMs)
    case 'subagent': return scoreSubagent(c, opts)
    case 'rule':     return scoreRule(c)
  }
}

export function scoreSkill(c: GeneratedCandidate, nowMs: number, opts: RankOptions): number {
  const cluster = c.sourceClusterId ? opts.clustersById?.get(c.sourceClusterId) : undefined
  const recurrence = cluster?.recurrenceCount ?? c.sourceRefs.length
  const recencyDays = cluster?.recencyDays ?? recencyDaysFromRefs(c, nowMs)
  const total = cluster
    ? cluster.outcomeBreakdown.succeeded + cluster.outcomeBreakdown.failed
      + cluster.outcomeBreakdown.abandoned + cluster.outcomeBreakdown.partial
    : 0
  const successRate = total > 0
    ? cluster!.outcomeBreakdown.succeeded / total
    : 1 // Detector pre-filter already enforces >= 0.6; if no cluster info, assume ok.

  let personalizationCount = 0
  if (cluster && opts.summariesByArc) {
    for (const arcId of cluster.members) {
      const s = opts.summariesByArc.get(arcId)
      if (s) personalizationCount += s.personalizationSignals.length
    }
  }
  const personalizationWeight = 1 + 0.5 * (personalizationCount / 5)

  return recurrence * recencyDecay(recencyDays) * successRate * personalizationWeight
}

export function scoreCommand(c: GeneratedCandidate, nowMs: number): number {
  const invocations = c.invocationCount ?? c.sourceRefs.length
  const recencyDays = recencyDaysFromRefs(c, nowMs)
  const promptLen = c.promptText?.length ?? c.bodyDraft.length
  return invocations * recencyDecay(recencyDays) * Math.log(promptLen + 1)
}

export function scoreSubagent(c: GeneratedCandidate, opts: RankOptions): number {
  const recurrence = c.sourceRefs.length
  const constituents = c.constituentSkills ?? []
  const complexity = Math.max(1, constituents.length)
  const coverage = opts.existingSkillNames
    ? constituents.filter(n => opts.existingSkillNames!.has(n)).length / Math.max(1, complexity)
    : 0
  return recurrence * complexity * (coverage + 0.5)
}

export function scoreRule(c: GeneratedCandidate): number {
  const breadth = c.sourceRefs.length
  const ruleText = c.ruleText ?? c.bodyDraft
  return breadth * specificityScore(ruleText)
}

// ---- Helpers ----------------------------------------------------------------

/** 1 / (1 + days/30) — gives 1 at 0 days, ~0.5 at 30 days, ~0.25 at 90 days. */
export function recencyDecay(days: number): number {
  if (!Number.isFinite(days) || days < 0) return 1
  return 1 / (1 + days / 30)
}

function recencyDaysFromRefs(c: GeneratedCandidate, nowMs: number): number {
  let max = -Infinity
  for (const r of c.sourceRefs) {
    const t = Date.parse(r.at)
    if (Number.isFinite(t) && t > max) max = t
  }
  if (!Number.isFinite(max)) return 0
  return Math.max(0, (nowMs - max) / 86_400_000)
}

/** Specificity proxy: long, lexically rich rule text scores higher than a
 *  generic one-liner. Uses normalized text length + distinct-content-word
 *  count. No external corpus needed. */
export function specificityScore(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  const lengthFactor = Math.min(1, trimmed.length / 160)
  const words = trimmed.toLowerCase().split(/\s+/).filter(w => w.length > 3)
  const distinct = new Set(words).size
  const richness = Math.min(1, distinct / 12)
  // 0.5 floor keeps "use prettier" from scoring 0 just because it's short.
  return 0.5 + lengthFactor + richness
}

// Test seam
export const __test = {
  recencyDecay,
  specificityScore,
  recencyDaysFromRefs,
  scoreSkill,
  scoreCommand,
  scoreSubagent,
  scoreRule,
}

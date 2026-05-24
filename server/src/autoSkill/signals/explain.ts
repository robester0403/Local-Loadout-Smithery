// Phase 6 (LOC-77): templated `reasonForUser` strings. No LLM cost — every
// candidate emerges from the pipeline with a short, plain-English
// explanation interpolated from the same cluster/summary data the
// detectors already used.
//
// Refinement variant prepends a preamble so the UI can show "refines your
// existing X" without separate routing.

import type { Candidate } from '../types'
import type { IntentCluster, ConversationSummary } from './types'
import type { GeneratedCandidate as CommandGenerated } from './detectors/commands'

export type GeneratedCandidate = CommandGenerated

export interface ExplainOptions {
  clustersById?: Map<string, IntentCluster>
  summariesByArc?: Map<string, ConversationSummary>
  nowMs?: number
}

export function generateReasonForUser(
  candidate: GeneratedCandidate,
  opts: ExplainOptions = {},
): string {
  const base = generateBaseReason(candidate, opts)
  if (candidate.existingMatch) {
    return `This refines your existing ${candidate.suggestedType} "${candidate.existingMatch.skillName}": ${base}`
  }
  return base
}

function generateBaseReason(c: GeneratedCandidate, opts: ExplainOptions): string {
  switch (c.suggestedType) {
    case 'skill':    return explainSkill(c, opts)
    case 'command':  return explainCommand(c, opts)
    case 'subagent': return explainSubagent(c)
    case 'rule':     return explainRule(c)
  }
}

function explainSkill(c: GeneratedCandidate, opts: ExplainOptions): string {
  const cluster = c.sourceClusterId ? opts.clustersById?.get(c.sourceClusterId) : undefined
  if (cluster) {
    const total = cluster.outcomeBreakdown.succeeded + cluster.outcomeBreakdown.failed
      + cluster.outcomeBreakdown.abandoned + cluster.outcomeBreakdown.partial
    const succ = cluster.outcomeBreakdown.succeeded
    const dateSpan = formatDateRange(cluster.dateSpan.start, cluster.dateSpan.end)
    const recent = formatRecency(cluster.dateSpan.end)
    return `This pattern appeared in ${cluster.recurrenceCount} conversations ${dateSpan}. Most recent: ${recent}. ${succ} of ${total} ended successfully with the same approach.`
  }
  const n = c.sourceRefs.length
  const recent = mostRecentRef(c)
  return `This pattern appeared in ${n} conversations. Most recent: ${recent}.`
}

function explainCommand(c: GeneratedCandidate, _opts: ExplainOptions): string {
  const invocations = c.invocationCount ?? c.sourceRefs.length
  const convCount = new Set(c.sourceRefs.map(r => r.conversationId)).size
  const recent = mostRecentRef(c)
  return `You typed this prompt ${invocations} time${plural(invocations)} across ${convCount} conversation${plural(convCount)}. Most recent: ${recent}.`
}

function explainSubagent(c: GeneratedCandidate): string {
  const skills = c.constituentSkills ?? []
  const skillList = skills.length > 0 ? `[${skills.join(', ')}]` : '[no named skills detected]'
  const n = c.sourceRefs.length
  return `You ran skills ${skillList} in this sequence across ${n} conversations to accomplish similar bounded outcomes.`
}

function explainRule(c: GeneratedCandidate): string {
  const n = c.sourceRefs.length
  return `This directive appeared in ${n} conversations across different task types — looks like an always-on convention rather than a per-task instruction.`
}

// ---- Formatting helpers -----------------------------------------------------

function formatDateRange(startIso: string, endIso: string): string {
  const start = formatShortDate(startIso)
  const end = formatShortDate(endIso)
  if (!start || !end) return ''
  if (start === end) return `on ${start}`
  return `between ${start} and ${end}`
}

function formatRecency(iso: string): string {
  const d = formatShortDate(iso)
  return d || 'unknown'
}

function formatShortDate(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  return new Date(t).toISOString().slice(0, 10) // YYYY-MM-DD
}

function mostRecentRef(c: GeneratedCandidate): string {
  let maxIso = ''
  let maxT = -Infinity
  for (const r of c.sourceRefs) {
    const t = Date.parse(r.at)
    if (Number.isFinite(t) && t > maxT) { maxT = t; maxIso = r.at }
  }
  return formatShortDate(maxIso) || 'unknown'
}

function plural(n: number): string {
  return n === 1 ? '' : 's'
}

// Apply `generateReasonForUser` to every candidate, populating
// `reasonForUser` in place of a missing one.
export function annotateWithReason(
  candidates: GeneratedCandidate[],
  opts: ExplainOptions = {},
): GeneratedCandidate[] {
  return candidates.map(c => ({
    ...c,
    reasonForUser: c.reasonForUser ?? generateReasonForUser(c, opts),
  }))
}

export const __test = {
  formatShortDate,
  formatDateRange,
  formatRecency,
  mostRecentRef,
}

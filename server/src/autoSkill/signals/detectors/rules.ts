// Detector A (LOC-74): Rule candidates that land as text blocks inside the
// ecosystem's global md file (CLAUDE.md / AGENTS.md). High bar — always-on
// rules pay the token tax on EVERY conversation, so we need to be sure the
// directive is a true convention rather than a per-task instruction.
//
// Steps:
//   1. Scan summaries[].personalizationSignals + correctionMarkers for
//      directive-shaped quotes ("always X", "never Y", "prefer Z", etc.).
//   2. Group near-duplicates (normalized Levenshtein < 0.2).
//   3. Cross-cluster check: drop directives that appear only inside ONE
//      cluster's member conversations (task-specific, not always-on).
//   4. Threshold: ≥ minConversations distinct conversations.
//   5. Single LLM classifier call to filter convention-shaped from
//      task-specific. Cap on calls is 1 per digest run.
//   6. Dedup vs existing rule files: skip if marker id collides, or if
//      embedding similarity vs file body > similarityThreshold.

import crypto from 'crypto'
import type { Candidate, CandidateSourceRef } from '../../types'
import type { ConversationSummary, IntentCluster } from '../types'
import { normalizedLevenshtein } from '../lib/levenshtein'
import {
  computeRuleMarkerId,
  type ExistingRuleFile,
} from '../lib/ruleMarkers'

const DEFAULT_MIN_CONVERSATIONS = 5
const DEFAULT_SIMILARITY_THRESHOLD = 0.7
const DEDUP_DISTANCE = 0.2

const DIRECTIVE_PATTERNS: Array<{ re: RegExp; section: string }> = [
  { re: /\balways\s+\S+/i,                  section: 'Conventions' },
  { re: /\bnever\s+\S+/i,                   section: 'Conventions' },
  { re: /\bdon't\s+\S+/i,                   section: 'Conventions' },
  { re: /\bdo not\s+\S+/i,                  section: 'Conventions' },
  { re: /\bprefer\s+\S+/i,                  section: 'Conventions' },
  { re: /\buse\s+\S+\s+instead\b/i,         section: 'Conventions' },
  { re: /\bstop\s+\S+ing\b/i,               section: 'Conventions' },
  { re: /\bavoid\s+\S+/i,                   section: 'Conventions' },
  { re: /\bmake sure\s+\S+/i,               section: 'Conventions' },
  { re: /\brun\s+\S+\s+before\s+\S+/i,      section: 'Tooling' },
]

export type GeneratedCandidate = Omit<Candidate, 'id' | 'status' | 'createdAt' | 'updatedAt'>

export type RuleClassifierFn = (directives: string[]) => Promise<boolean[]>
export type RuleEmbedFn = (text: string) => Promise<number[]>

export interface RuleDetectorOptions {
  existingRuleFiles?: ExistingRuleFile[]
  /** Single LLM call mapping directives → is-convention bool. */
  llmClassifier?: RuleClassifierFn
  embedFn?: RuleEmbedFn
  minConversations?: number
  similarityThreshold?: number
  model?: string
}

interface DirectiveOccurrence {
  text: string
  section: string
  source: 'claude' | 'cursor' | 'codex'
  conversationId: string
  arcId: string
  startedAt: string
}

interface DirectiveGroup {
  canonical: string
  section: string
  occurrences: DirectiveOccurrence[]
  /** Unique conversation ids. */
  conversations: Set<string>
  /** Unique arc ids — used for the cross-cluster spread check. */
  arcs: Set<string>
}

export async function detectRules(
  summaries: ConversationSummary[],
  clusters: IntentCluster[],
  opts: RuleDetectorOptions = {},
): Promise<GeneratedCandidate[]> {
  const minConvos = opts.minConversations ?? DEFAULT_MIN_CONVERSATIONS
  const simThreshold = opts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD
  const model = opts.model ?? 'signal-pipeline'
  const existing = opts.existingRuleFiles ?? []

  // 1. Mine directive-shaped quotes from personalizationSignals + correctionMarkers.
  const occurrences: DirectiveOccurrence[] = []
  for (const s of summaries) {
    for (const p of s.personalizationSignals) {
      const text = p.evidence.trim()
      const matched = matchDirective(text)
      if (matched) occurrences.push({
        text,
        section: matched,
        source: s.source,
        conversationId: s.conversationId,
        arcId: s.arcId,
        startedAt: s.startedAt,
      })
    }
    for (const c of s.correctionMarkers) {
      const text = c.quote.trim()
      const matched = matchDirective(text)
      if (matched) occurrences.push({
        text,
        section: matched,
        source: s.source,
        conversationId: s.conversationId,
        arcId: s.arcId,
        startedAt: s.startedAt,
      })
    }
  }

  // 2. Group near-duplicates.
  const groups = groupOccurrences(occurrences)

  // 3. Cross-cluster spread check + 4. ≥ minConversations threshold.
  const arcToCluster = buildArcToClusterIndex(clusters)
  const surviving = groups.filter(g => {
    if (g.conversations.size < minConvos) return false
    const clusterIds = new Set<string>()
    for (const a of g.arcs) {
      const cid = arcToCluster.get(a)
      if (cid != null) clusterIds.add(cid)
    }
    // "Appears only in one cluster's context" = task-specific. Require
    // either zero clusters (free-floating across non-clustered arcs, which
    // is fine — they're spread by definition) or ≥ 2 distinct clusters.
    return clusterIds.size !== 1
  })

  if (surviving.length === 0) return []

  // 5. Single LLM classifier call.
  const classifications = await classifyDirectives(
    surviving.map(g => g.canonical),
    opts.llmClassifier,
  )
  const conventionGroups = surviving.filter((_, i) => classifications[i])

  if (conventionGroups.length === 0) return []

  // 6. Dedup vs existing rule files.
  const out: GeneratedCandidate[] = []
  for (const g of conventionGroups) {
    const markerId = computeRuleMarkerId(g.canonical, g.section)
    if (existing.some(f => f.markerIds.has(markerId))) continue

    if (opts.embedFn && existing.length > 0) {
      const dup = await isSemanticallyDuplicate(g.canonical, existing, opts.embedFn, simThreshold)
      if (dup) continue
    }

    out.push(buildCandidate(g, markerId, model))
  }

  return out
}

// ---- Directive detection ----------------------------------------------------

export function matchDirective(text: string): string | null {
  for (const p of DIRECTIVE_PATTERNS) {
    if (p.re.test(text)) return p.section
  }
  return null
}

function groupOccurrences(occurrences: DirectiveOccurrence[]): DirectiveGroup[] {
  const groups: DirectiveGroup[] = []
  for (const occ of occurrences) {
    let matched: DirectiveGroup | null = null
    for (const g of groups) {
      if (g.section !== occ.section) continue
      if (normalizedLevenshtein(g.canonical.toLowerCase(), occ.text.toLowerCase()) < DEDUP_DISTANCE) {
        matched = g
        break
      }
    }
    if (matched) {
      matched.occurrences.push(occ)
      matched.conversations.add(occ.conversationId)
      matched.arcs.add(occ.arcId)
      // Keep the longest seen as canonical — more context for the user.
      if (occ.text.length > matched.canonical.length) matched.canonical = occ.text
    } else {
      groups.push({
        canonical: occ.text,
        section: occ.section,
        occurrences: [occ],
        conversations: new Set([occ.conversationId]),
        arcs: new Set([occ.arcId]),
      })
    }
  }
  return groups
}

function buildArcToClusterIndex(clusters: IntentCluster[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const c of clusters) {
    for (const a of c.members) out.set(a, c.clusterId)
  }
  return out
}

// ---- LLM classifier ---------------------------------------------------------

async function classifyDirectives(
  directives: string[],
  injected?: RuleClassifierFn,
): Promise<boolean[]> {
  if (directives.length === 0) return []
  if (injected) {
    try {
      const result = await injected(directives)
      // Defensive: classifier may return wrong-shape array. Length mismatch
      // means we can't trust the alignment; fall back to drop-all.
      if (!Array.isArray(result) || result.length !== directives.length) {
        return directives.map(() => false)
      }
      return result.map(r => r === true)
    } catch {
      // Classifier threw → don't poison CLAUDE.md with un-classified directives.
      return directives.map(() => false)
    }
  }
  // No injected classifier — drop everything. Rule candidates pollute the
  // user's global instructions on accept; the conservative default protects
  // them when the orchestrator hasn't wired a classifier. The bug here used
  // to be all-true, which can append bogus directives that the user has to
  // notice + reject one at a time.
  return directives.map(() => false)
}

// ---- Semantic dedup ---------------------------------------------------------

async function isSemanticallyDuplicate(
  text: string,
  files: ExistingRuleFile[],
  embedFn: RuleEmbedFn,
  threshold: number,
): Promise<boolean> {
  const v = normalize(await embedFn(text))
  for (const f of files) {
    if (!f.body.trim()) continue
    const other = normalize(await embedFn(f.body))
    const sim = dot(v, other)
    if (sim > threshold) return true
  }
  return false
}

function dot(a: number[], b: number[]): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

function normalize(a: number[]): number[] {
  let mag = 0
  for (const x of a) mag += x * x
  mag = Math.sqrt(mag)
  if (mag === 0) return a.slice()
  return a.map(x => x / mag)
}

// ---- Candidate construction -------------------------------------------------

function buildCandidate(g: DirectiveGroup, markerId: string, model: string): GeneratedCandidate {
  const sourceRefs = buildSourceRefs(g.occurrences)
  const sourcesUsed = new Set(g.occurrences.map(o => o.source))
  return {
    signature: `rule::${markerId}`,
    name: titleFromRule(g.canonical),
    description: `Always-on rule for ${[...sourcesUsed].sort().join('+')}: ${firstLine(g.canonical)}`,
    bodyDraft: g.canonical,
    suggestedType: 'rule',
    score: 0,
    sourceRefs,
    model,
    ruleText: g.canonical,
    suggestedSection: g.section,
    evidenceQuotes: g.occurrences.slice(0, 3).map(o => ({
      conversationId: o.conversationId,
      quote: o.text.slice(0, 200),
    })),
  }
}

function titleFromRule(rule: string): string {
  const trimmed = rule.replace(/[\.,;:!?]+$/, '').trim()
  if (trimmed.length <= 60) return trimmed
  return trimmed.slice(0, 57) + '…'
}

function firstLine(text: string): string {
  return text.split('\n')[0].trim().slice(0, 160)
}

function buildSourceRefs(occurrences: DirectiveOccurrence[]): CandidateSourceRef[] {
  const byConv = new Map<string, DirectiveOccurrence>()
  for (const o of occurrences) if (!byConv.has(o.conversationId)) byConv.set(o.conversationId, o)
  return [...byConv.values()].map(o => ({
    source: o.source,
    conversationId: o.conversationId,
    excerpt: o.text.slice(0, 120),
    at: o.startedAt,
  }))
}

// Test seam
export const __test = {
  matchDirective,
  groupOccurrences,
  buildArcToClusterIndex,
  computeRuleMarkerId,
  titleFromRule,
  hashSig: (t: string): string => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16),
}

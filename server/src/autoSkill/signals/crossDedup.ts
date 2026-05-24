// Cross-detector dedup + name-uniqueness pass (LOC-89).
//
// The 4 detectors (skill, command, subagent, rule) run in parallel from the
// SAME corpus and routinely emit the same idea under different types. This
// pass runs after detector merge and before dedup-against-existing:
//
//   1. collapseCrossDetector — embeds name+description for each candidate,
//      collapses pairs above the cosine threshold by keeping the higher-
//      priority type.
//   2. rejectNameCollisions — drops any candidate whose slug collides with
//      another candidate (different type) or with an existing artifact of
//      any type.
//
// Priority order: skill > subagent > command > rule. Reasoning: skill bar
// is strictest (arc-level + programmatic consistency check); rule bar is
// broadest. When two detectors emit the same idea, keep the stronger signal.

import type { CandidateType } from '../types'
import type { GeneratedCandidate, ExistingArtifact, DedupEmbedFn } from './dedup'
import { embedText, type EmbedOptions } from './embed'

const CROSS_DETECTOR_THRESHOLD = 0.85

const TYPE_PRIORITY: Record<CandidateType, number> = {
  skill: 4,
  subagent: 3,
  command: 2,
  rule: 1,
}

export interface CrossDedupOptions {
  embedFn?: DedupEmbedFn
  embedModel?: string
  similarityThreshold?: number
}

export interface CrossDedupResult {
  kept: GeneratedCandidate[]
  /** Candidates removed by this pass — each entry carries a short reason
   *  the caller can surface in `detectorWarnings`. */
  dropped: Array<{ candidate: GeneratedCandidate; reason: string }>
}

/** Slugify identical to emit.ts `sanitizeName` so the upstream uniqueness
 *  check matches the downstream filesystem write. Kept local to avoid a
 *  cross-cutting dependency from signals/ → emit.ts; tests cover parity. */
export function slugify(name: string): string {
  const safe = name.toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return safe.slice(0, 60)
}

function priority(t: CandidateType): number {
  return TYPE_PRIORITY[t] ?? 0
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

/** Collapse semantically-equivalent candidates emitted by different
 *  detectors. Keeps the higher-priority type on collision. */
export async function collapseCrossDetector(
  candidates: GeneratedCandidate[],
  opts: CrossDedupOptions = {},
): Promise<CrossDedupResult> {
  if (candidates.length < 2) return { kept: candidates, dropped: [] }

  const threshold = opts.similarityThreshold ?? CROSS_DETECTOR_THRESHOLD
  const embedOpts: EmbedOptions = opts.embedModel ? { model: opts.embedModel } : {}
  const embed = opts.embedFn ?? ((t: string) => embedText(t, embedOpts))

  const vectors: number[][] = []
  for (const c of candidates) {
    vectors.push(normalize(await embed(`${c.name}\n${c.description}`)))
  }

  // Sort indices by priority (highest first) so when we walk and skip
  // already-collapsed candidates, the survivor is always the strongest.
  const order = candidates
    .map((c, i) => ({ i, p: priority(c.suggestedType) }))
    .sort((a, b) => b.p - a.p)
    .map(x => x.i)

  const removed = new Set<number>()
  for (const i of order) {
    if (removed.has(i)) continue
    for (const j of order) {
      if (j === i || removed.has(j)) continue
      if (priority(candidates[j].suggestedType) > priority(candidates[i].suggestedType)) continue
      const sim = dot(vectors[i], vectors[j])
      if (sim > threshold) removed.add(j)
    }
  }

  const kept: GeneratedCandidate[] = []
  const dropped: CrossDedupResult['dropped'] = []
  for (let i = 0; i < candidates.length; i++) {
    if (removed.has(i)) {
      dropped.push({
        candidate: candidates[i],
        reason: `cross-detector duplicate: ${candidates[i].suggestedType} "${candidates[i].name}" semantically matches a higher-priority candidate`,
      })
    } else {
      kept.push(candidates[i])
    }
  }
  return { kept, dropped }
}

/** Drop candidates whose slug collides with another candidate (different
 *  type) or with an existing artifact of any type. Higher-priority type
 *  survives intra-candidate collisions. Cross-collisions with existing
 *  artifacts always drop the candidate — the existing artifact is the
 *  source of truth on disk. */
export function rejectNameCollisions(
  candidates: GeneratedCandidate[],
  existing: ExistingArtifact[],
): CrossDedupResult {
  if (candidates.length === 0) return { kept: candidates, dropped: [] }

  const existingSlugs = new Map<string, ExistingArtifact>()
  for (const a of existing) existingSlugs.set(slugify(a.name), a)

  // Sort by priority so when two candidates share a slug, the higher-
  // priority one wins. Walk in priority order, mark the loser.
  const order = candidates
    .map((c, i) => ({ i, p: priority(c.suggestedType) }))
    .sort((a, b) => b.p - a.p)
    .map(x => x.i)

  const claimedSlugs = new Map<string, number>() // slug → winning candidate index
  const removed = new Map<number, string>() // index → reason

  for (const i of order) {
    const c = candidates[i]
    const slug = slugify(c.name)
    if (!slug) {
      removed.set(i, `name "${c.name}" sanitizes to empty slug`)
      continue
    }
    const existingHit = existingSlugs.get(slug)
    if (existingHit) {
      removed.set(i, `slug "${slug}" collides with existing ${existingHit.kind} "${existingHit.name}"`)
      continue
    }
    const claimedBy = claimedSlugs.get(slug)
    if (claimedBy !== undefined) {
      const winner = candidates[claimedBy]
      removed.set(i, `slug "${slug}" already claimed by ${winner.suggestedType} candidate "${winner.name}" (higher priority)`)
      continue
    }
    claimedSlugs.set(slug, i)
  }

  const kept: GeneratedCandidate[] = []
  const dropped: CrossDedupResult['dropped'] = []
  for (let i = 0; i < candidates.length; i++) {
    const reason = removed.get(i)
    if (reason) dropped.push({ candidate: candidates[i], reason })
    else kept.push(candidates[i])
  }
  return { kept, dropped }
}

export const __test = { slugify, priority, TYPE_PRIORITY, CROSS_DETECTOR_THRESHOLD }

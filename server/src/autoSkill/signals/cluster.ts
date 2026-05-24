// Phase 2 of the signal-detection pipeline (LOC-69 / LOC-73): cluster the
// per-arc `ConversationSummary[]` into `IntentCluster[]`.
//
// Approach: deterministic k-means over normalized sentence embeddings of
// `intent + sorted slot values`. Centroid-based selection per arXiv 2502.17321
// (Choubey et al.) — centroid beats diversity for workflow extraction;
// "prioritizing diversity introduces noise from real-world conversations."
//
// Filters per the same paper + SkillsBench:
//   - drop clusters with < 3 members (Fowler/Roberts rule of three)
//   - drop clusters with < 60% success rate (low-success skills degrade
//     performance per SkillsBench)
//
// k is picked by a simple elbow heuristic: try k=1..min(N/3, 10), stop at
// the smallest k where adding another cluster reduces WCSS by < 15%. This is
// less precise than a true elbow-finder but stable, deterministic, and good
// enough for the small N (~tens to hundreds of summaries) we operate on.

import { clearEmbedCache, embedText } from './embed'
import type { ConversationSummary, IntentCluster } from './types'

const DEFAULT_MAX_K = 10
const DEFAULT_MIN_MEMBERS = 3
const DEFAULT_MIN_SUCCESS_RATE = 0.6
const KMEANS_MAX_ITER = 50
const ELBOW_IMPROVEMENT_THRESHOLD = 0.15
// If WCSS is already below this absolute floor, additional clusters won't
// help — relative-improvement math would otherwise amplify tiny absolute
// noise into "looks like a real elbow" and oversplit tight clusters into
// singletons.
const WCSS_ABSOLUTE_FLOOR = 0.05

export type EmbedFn = (text: string) => Promise<number[]>

export interface ClusterOptions {
  /** Override the embedder. Default routes through embed.ts → Ollama. */
  embedFn?: EmbedFn
  /** Embedding model name (passed to default embedder). */
  model?: string
  /** Cap on k for k-means. Default 10. */
  maxK?: number
  /** Minimum cluster size to keep. Default 3. */
  minMembers?: number
  /** Minimum success rate to keep. Default 0.6. */
  minSuccessRate?: number
  /** "Now" epoch ms for recencyDays. Defaults to Date.now() at call time. */
  nowMs?: number
  /** Skip the internal embed cache clear-on-start (tests). */
  preserveEmbedCache?: boolean
}

// ---- Public entrypoint ------------------------------------------------------

export async function clusterSummaries(
  summaries: ConversationSummary[],
  opts: ClusterOptions = {},
): Promise<IntentCluster[]> {
  const minMembers = opts.minMembers ?? DEFAULT_MIN_MEMBERS
  const minSuccessRate = opts.minSuccessRate ?? DEFAULT_MIN_SUCCESS_RATE
  const maxK = opts.maxK ?? DEFAULT_MAX_K
  const now = opts.nowMs ?? Date.now()
  const embed = opts.embedFn ?? ((t: string) => embedText(t, opts.model ? { model: opts.model } : {}))

  if (!opts.preserveEmbedCache) clearEmbedCache()

  if (summaries.length < minMembers) return []

  const vectors: number[][] = []
  for (const s of summaries) {
    const v = await embed(intentEmbeddingText(s))
    vectors.push(normalize(v))
  }

  // Allow up to one cluster per summary; the minMembers filter drops
  // singletons. The cap stays at maxK for compute reasons.
  const kCap = Math.min(maxK, summaries.length)
  const assignments = pickBestKMeans(vectors, kCap)

  const out: IntentCluster[] = []
  const groups = groupAssignments(assignments)
  for (const [_clusterIdx, memberIdxs] of groups) {
    if (memberIdxs.length < minMembers) continue
    const members = memberIdxs.map(i => summaries[i])
    const memberVecs = memberIdxs.map(i => vectors[i])

    const successCount = members.filter(m => m.outcome === 'succeeded').length
    if (successCount / members.length < minSuccessRate) continue

    const centroidIdx = pickCentroid(memberVecs)
    const centroid = members[centroidIdx]

    out.push(buildCluster(members, centroid, now))
  }

  // Stable ordering: by recurrenceCount desc, then recencyDays asc.
  out.sort((a, b) => b.recurrenceCount - a.recurrenceCount || a.recencyDays - b.recencyDays)
  // Reassign ids in sorted order.
  return out.map((c, i) => ({ ...c, clusterId: `cluster-${i}` }))
}

// ---- Embedding text ---------------------------------------------------------

export function intentEmbeddingText(s: ConversationSummary): string {
  const slotParts: string[] = []
  for (const key of Object.keys(s.slotValues).sort()) {
    const vals = s.slotValues[key]
    if (vals && vals.length) {
      const sorted = [...vals].sort()
      slotParts.push(`${key}: ${sorted.join(', ')}`)
    }
  }
  return slotParts.length === 0 ? s.intent : `${s.intent} | ${slotParts.join(' | ')}`
}

// ---- K-means + elbow --------------------------------------------------------

interface KMeansFit {
  assignments: number[]
  wcss: number
}

function pickBestKMeans(vectors: number[][], kCap: number): number[] {
  if (kCap <= 1) return vectors.map(() => 0)

  // Fit k = 1..kCap once, then pick the elbow. Two stop conditions:
  //   1. Previous WCSS is already below an absolute floor — adding more
  //      clusters is amplifying noise, stop.
  //   2. Relative improvement from k-1 → k is below the elbow threshold —
  //      the curve has flattened, stop.
  // Either way, we keep the previous fit (the one BEFORE the marginal k).
  const fits: KMeansFit[] = []
  for (let k = 1; k <= kCap; k++) fits.push(kmeans(vectors, k))

  let chosen = 0
  for (let i = 1; i < fits.length; i++) {
    if (fits[i - 1].wcss < WCSS_ABSOLUTE_FLOOR) break
    const improvement = fits[i - 1].wcss > 0
      ? (fits[i - 1].wcss - fits[i].wcss) / fits[i - 1].wcss
      : 0
    if (improvement < ELBOW_IMPROVEMENT_THRESHOLD) break
    chosen = i
  }

  return fits[chosen].assignments
}

function kmeans(vectors: number[][], k: number): KMeansFit {
  const dim = vectors[0]?.length ?? 0
  if (k <= 1 || vectors.length === 0) {
    // Normalize the mean centroid so cosineDistance (which assumes unit
    // vectors) returns a comparable value to the iterative path below. Before
    // this fix, a spread cluster's k=1 WCSS was artificially large because
    // the unnormalized mean had magnitude < 1, which made the elbow heuristic
    // oversplit (it thought k=2 was a huge improvement when it wasn't).
    const centroid = vectors.length > 0 ? normalize(meanVector(vectors, dim)) : meanVector(vectors, dim)
    return { assignments: vectors.map(() => 0), wcss: totalWcss(vectors, [centroid], vectors.map(() => 0)) }
  }

  // Deterministic seed init (k-means++ style, no RNG): first centroid is
  // vectors[0]; each subsequent is the point furthest (by 1-cos) from any
  // existing centroid. Ties broken by index.
  const centroids: number[][] = [vectors[0].slice()]
  while (centroids.length < k && centroids.length < vectors.length) {
    let bestIdx = -1
    let bestDist = -Infinity
    for (let i = 0; i < vectors.length; i++) {
      let nearest = Infinity
      for (const c of centroids) nearest = Math.min(nearest, cosineDistance(vectors[i], c))
      if (nearest > bestDist) {
        bestDist = nearest
        bestIdx = i
      }
    }
    if (bestIdx < 0) break
    centroids.push(vectors[bestIdx].slice())
  }

  let assignments = vectors.map(() => -1)
  for (let iter = 0; iter < KMEANS_MAX_ITER; iter++) {
    let changed = false
    const next = assignNearest(vectors, centroids)
    for (let i = 0; i < next.length; i++) {
      if (next[i] !== assignments[i]) {
        changed = true
        break
      }
    }
    assignments = next
    if (!changed && iter > 0) break
    for (let c = 0; c < centroids.length; c++) {
      const members = vectors.filter((_, i) => assignments[i] === c)
      if (members.length === 0) continue
      centroids[c] = normalize(meanVector(members, dim))
    }
  }

  return { assignments, wcss: totalWcss(vectors, centroids, assignments) }
}

function assignNearest(vectors: number[][], centroids: number[][]): number[] {
  const out: number[] = []
  for (const v of vectors) {
    let best = 0
    let bestD = Infinity
    for (let c = 0; c < centroids.length; c++) {
      const d = cosineDistance(v, centroids[c])
      if (d < bestD) {
        bestD = d
        best = c
      }
    }
    out.push(best)
  }
  return out
}

function totalWcss(vectors: number[][], centroids: number[][], assignments: number[]): number {
  let s = 0
  for (let i = 0; i < vectors.length; i++) {
    const d = cosineDistance(vectors[i], centroids[assignments[i]] ?? centroids[0])
    s += d * d
  }
  return s
}

function groupAssignments(assignments: number[]): Array<[number, number[]]> {
  const m = new Map<number, number[]>()
  for (let i = 0; i < assignments.length; i++) {
    const c = assignments[i]
    const arr = m.get(c) ?? []
    arr.push(i)
    m.set(c, arr)
  }
  return [...m.entries()]
}

// ---- Vector math ------------------------------------------------------------

function dot(a: number[], b: number[]): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

function magnitude(a: number[]): number {
  let s = 0
  for (const x of a) s += x * x
  return Math.sqrt(s)
}

function normalize(a: number[]): number[] {
  const m = magnitude(a)
  if (m === 0) return a.slice()
  return a.map(x => x / m)
}

function meanVector(vectors: number[][], dim: number): number[] {
  const out = new Array<number>(dim).fill(0)
  if (vectors.length === 0) return out
  for (const v of vectors) {
    const n = Math.min(dim, v.length)
    for (let i = 0; i < n; i++) out[i] += v[i]
  }
  for (let i = 0; i < dim; i++) out[i] /= vectors.length
  return out
}

/** Cosine distance on already-normalized vectors. Range [0, 2]. */
export function cosineDistance(a: number[], b: number[]): number {
  return 1 - dot(a, b)
}

// ---- Centroid selection -----------------------------------------------------

/** Returns the index of the cluster member with the smallest sum of cosine
 *  distances to all other members. */
export function pickCentroid(vectors: number[][]): number {
  if (vectors.length === 0) return -1
  if (vectors.length === 1) return 0
  let best = 0
  let bestSum = Infinity
  for (let i = 0; i < vectors.length; i++) {
    let sum = 0
    for (let j = 0; j < vectors.length; j++) {
      if (i === j) continue
      sum += cosineDistance(vectors[i], vectors[j])
    }
    if (sum < bestSum) {
      bestSum = sum
      best = i
    }
  }
  return best
}

// ---- Aggregation ------------------------------------------------------------

export function buildCluster(
  members: ConversationSummary[],
  centroid: ConversationSummary,
  nowMs: number,
): IntentCluster {
  const tsList = members
    .map(m => Date.parse(m.startedAt))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b)

  const start = tsList[0]
  const end = tsList[tsList.length - 1]
  const startIso = Number.isFinite(start) ? new Date(start).toISOString() : centroid.startedAt
  const endIso = Number.isFinite(end) ? new Date(end).toISOString() : centroid.startedAt

  const gaps: number[] = []
  for (let i = 1; i < tsList.length; i++) gaps.push((tsList[i] - tsList[i - 1]) / 86_400_000)
  const medianGap = median(gaps)

  const recencyDays = Number.isFinite(end) ? Math.max(0, (nowMs - end) / 86_400_000) : 0

  const outcomeBreakdown = { succeeded: 0, failed: 0, abandoned: 0, partial: 0 }
  for (const m of members) outcomeBreakdown[m.outcome] += 1

  return {
    clusterId: 'cluster-pending',
    members: members.map(m => m.arcId),
    centroidIntent: centroid.intent,
    centroidSlotValues: centroid.slotValues,
    recurrenceCount: members.length,
    dateSpan: { start: startIso, end: endIso },
    medianGapDays: medianGap,
    recencyDays,
    commonToolSignature: intersectAll(members.map(m => m.toolSignature)),
    convergentApproach: intersectAll(members.map(m => m.resolutionSteps)),
    outcomeBreakdown,
  }
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export function intersectAll(arrays: string[][]): string[] {
  if (arrays.length === 0) return []
  let acc = new Set(arrays[0])
  for (let i = 1; i < arrays.length; i++) {
    const next = new Set<string>()
    for (const x of arrays[i]) if (acc.has(x)) next.add(x)
    acc = next
    if (acc.size === 0) break
  }
  // Preserve first-array order for determinism.
  return arrays[0].filter(x => acc.has(x))
}

// Test seam
export const __test = {
  kmeans,
  pickBestKMeans,
  cosineDistance,
  pickCentroid,
  intersectAll,
  intentEmbeddingText,
  buildCluster,
  median,
  normalize,
}

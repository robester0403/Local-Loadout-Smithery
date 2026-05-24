// Phase 4 (LOC-77): dedup pipeline output against the user's existing
// library. Per the audit: populate the existing `Candidate.existingMatch`
// field rather than inventing a new flag. Cosine similarity > threshold →
// the candidate is a refinement of an existing artifact, not a sibling.
//
// Refinement candidates are NOT dropped — they surface to the user with a
// "refines existing X" badge so they can decide whether to merge or skip.

import type { Candidate, ExistingMatch } from '../types'
import { embedText, type EmbedOptions } from './embed'
import type { GeneratedCandidate as CommandGenerated } from './detectors/commands'

export type GeneratedCandidate = CommandGenerated

const DEFAULT_SIMILARITY_THRESHOLD = 0.8

export interface ExistingArtifact {
  id: string
  name: string
  path: string
  description: string
  kind: Candidate['suggestedType']
}

export type DedupEmbedFn = (text: string) => Promise<number[]>

export interface DedupOptions {
  /** Override the embedder (tests). Defaults to the in-memory `embedText`. */
  embedFn?: DedupEmbedFn
  embedModel?: string
  similarityThreshold?: number
}

export async function deduplicateCandidates(
  candidates: GeneratedCandidate[],
  existing: ExistingArtifact[],
  opts: DedupOptions = {},
): Promise<GeneratedCandidate[]> {
  const threshold = opts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD
  const embedOpts: EmbedOptions = opts.embedModel ? { model: opts.embedModel } : {}
  const embed = opts.embedFn ?? ((t: string) => embedText(t, embedOpts))

  if (candidates.length === 0) return candidates

  // Pre-embed existing artifacts so the inner loop only embeds candidates.
  const existingVectors: Array<{ artifact: ExistingArtifact; vec: number[] }> = []
  for (const a of existing) {
    const v = normalize(await embed(`${a.name}\n${a.description}`))
    existingVectors.push({ artifact: a, vec: v })
  }

  const out: GeneratedCandidate[] = []
  for (const c of candidates) {
    const sameKind = existingVectors.filter(e => e.artifact.kind === c.suggestedType)
    if (sameKind.length === 0) {
      out.push(c)
      continue
    }

    const candVec = normalize(await embed(`${c.name}\n${c.description}`))

    let best: { artifact: ExistingArtifact; sim: number } | null = null
    for (const e of sameKind) {
      const sim = dot(candVec, e.vec)
      if (!best || sim > best.sim) best = { artifact: e.artifact, sim }
    }

    if (best && best.sim > threshold) {
      const existingMatch: ExistingMatch = {
        skillId: best.artifact.id,
        skillName: best.artifact.name,
        skillPath: best.artifact.path,
        // Default to 'description' — we matched on name+description embedding,
        // and description carries more signal than name on its own.
        matchKind: 'description',
        similarity: best.sim,
      }
      out.push({ ...c, existingMatch })
    } else {
      out.push(c)
    }
  }

  return out
}

// ---- vector helpers ---------------------------------------------------------

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

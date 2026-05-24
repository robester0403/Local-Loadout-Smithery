import type { Skill } from '../scanner/types'
import type { Candidate, CandidateType, ExistingMatch } from './types'

export type MatchKind = 'name' | 'description'

// Re-export the shared ExistingMatch type so legacy import sites keep working.
// Single source of truth lives in ./types.ts.
export type { ExistingMatch }

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has',
  'he', 'her', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'so', 'that',
  'the', 'this', 'to', 'was', 'were', 'will', 'with', 'use', 'used',
  'when', 'user', 'users', 'this', 'these', 'their', 'them',
])

function tokenize(s: string): Set<string> {
  if (!s) return new Set()
  const tokens = s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t))
  return new Set(tokens)
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter += 1
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// Map scanner skill types into the candidate type space. The scanner emits
// 'skill' | 'command' | 'subagent' | 'mcp'; mcp is not a candidate target.
function asCandidateType(t: Skill['type']): CandidateType | null {
  if (t === 'skill' || t === 'command' || t === 'subagent') return t
  return null
}

// Find the strongest existing match for a candidate in the live inventory,
// or null if none crosses thresholds. Thresholds tuned to catch genuine
// duplicates without flagging every loosely-related skill:
//   - exact slug match → always wins
//   - description Jaccard ≥ 0.4 → match
//   - name Jaccard ≥ 0.5 → match (names are short, more lenient bar)
const NAME_JACCARD_THRESHOLD = 0.5
const DESC_JACCARD_THRESHOLD = 0.4

export function findExistingMatch(candidate: Candidate, skills: Skill[]): ExistingMatch | null {
  const candSlug = slugify(candidate.name)
  const candNameTokens = tokenize(candidate.name)
  const candDescTokens = tokenize(candidate.description)

  let best: ExistingMatch | null = null

  // Consider ALL inventory artifacts, not just the candidate's suggestedType.
  // A skill candidate can refine an existing command (and vice versa); the
  // ExistingMatch.kind field carries the matched artifact's type so the UI
  // can say "refines existing command X" instead of guessing.
  for (const s of skills) {
    const st = asCandidateType(s.type)
    if (!st) continue
    if (s.disabled) continue

    // 1) Exact-slug match → confident duplicate.
    if (slugify(s.name) === candSlug) {
      return {
        skillId: s.id, skillName: s.name, skillPath: s.path,
        matchKind: 'name', similarity: 1.0, kind: st,
      }
    }

    // 2) Name Jaccard.
    const nameSim = jaccard(candNameTokens, tokenize(s.name))
    if (nameSim >= NAME_JACCARD_THRESHOLD) {
      if (!best || nameSim > best.similarity) {
        best = {
          skillId: s.id, skillName: s.name, skillPath: s.path,
          matchKind: 'name', similarity: Number(nameSim.toFixed(3)), kind: st,
        }
      }
    }

    // 3) Description Jaccard.
    const descSim = jaccard(candDescTokens, tokenize(s.description))
    if (descSim >= DESC_JACCARD_THRESHOLD) {
      if (!best || descSim > best.similarity) {
        best = {
          skillId: s.id, skillName: s.name, skillPath: s.path,
          matchKind: 'description', similarity: Number(descSim.toFixed(3)), kind: st,
        }
      }
    }
  }

  return best
}

export const __test = { tokenize, jaccard, slugify }

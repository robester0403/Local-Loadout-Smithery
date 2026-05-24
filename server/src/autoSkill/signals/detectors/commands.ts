// Detector B (LOC-74): Command candidates. Low bar — slash-commands are
// near-zero cost (one listing entry, no auto-trigger), so we surface
// repeatable user prompts that look like they could be templated.
//
// No LLM calls in this detector — pure string heuristics.

import crypto from 'crypto'
import type { Candidate, CandidateSourceRef } from '../../types'
import type { ConversationSummary } from '../types'
import { normalizedLevenshtein } from '../lib/levenshtein'

const DEFAULT_MIN_OCCURRENCES = 2
const DEFAULT_MIN_PROMPT_LENGTH = 100
const DEFAULT_MAX_CODE_RATIO = 0.6
const DEFAULT_LEVENSHTEIN_THRESHOLD = 0.2

export type GeneratedCandidate = Omit<Candidate, 'id' | 'status' | 'createdAt' | 'updatedAt'>

export interface CommandDetectorOptions {
  /** Names/descriptions/prompts of existing commands in the user's library.
   *  Candidates near-duplicating any of these are dropped. */
  existingCommandTexts?: string[]
  minOccurrences?: number
  minPromptLength?: number
  /** Max ratio of "code-like" characters before a prompt is rejected. */
  maxCodeRatio?: number
  /** Normalized Levenshtein distance under which two prompts are merged. */
  levenshteinThreshold?: number
  /** Model field stamped on the candidate. Default 'signal-pipeline'. */
  model?: string
}

interface PromptOccurrence {
  text: string
  source: 'claude' | 'cursor' | 'codex'
  conversationId: string
  arcStartedAt: string
}

export function detectCommands(
  summaries: ConversationSummary[],
  opts: CommandDetectorOptions = {},
): GeneratedCandidate[] {
  const minOccurrences = opts.minOccurrences ?? DEFAULT_MIN_OCCURRENCES
  const minLen = opts.minPromptLength ?? DEFAULT_MIN_PROMPT_LENGTH
  const maxCode = opts.maxCodeRatio ?? DEFAULT_MAX_CODE_RATIO
  const threshold = opts.levenshteinThreshold ?? DEFAULT_LEVENSHTEIN_THRESHOLD
  const model = opts.model ?? 'signal-pipeline'

  const pool: PromptOccurrence[] = []
  for (const s of summaries) {
    for (const raw of s.verbatimUserPrompts) {
      const text = raw.trim()
      if (text.length < minLen) continue
      if (codeRatio(text) > maxCode) continue
      pool.push({
        text,
        source: s.source,
        conversationId: s.conversationId,
        arcStartedAt: s.startedAt,
      })
    }
  }

  // Greedy near-duplicate grouping. For each occurrence, attach to the first
  // existing group whose representative is within threshold, otherwise start
  // a new group. Order-dependent but stable.
  const groups: PromptOccurrence[][] = []
  for (const occ of pool) {
    let matched = false
    for (const g of groups) {
      if (normalizedLevenshtein(g[0].text, occ.text) < threshold) {
        g.push(occ)
        matched = true
        break
      }
    }
    if (!matched) groups.push([occ])
  }

  const existing = opts.existingCommandTexts ?? []

  const out: GeneratedCandidate[] = []
  for (const group of groups) {
    const distinctConvIds = new Set(group.map(g => g.conversationId))
    if (distinctConvIds.size < minOccurrences) continue

    // Pick the longest as the canonical text — more useful as a slash-command
    // template than the shortest.
    const canonical = [...group].sort((a, b) => b.text.length - a.text.length)[0].text

    if (existing.some(e => normalizedLevenshtein(e, canonical) < threshold)) continue

    const slug = slugFromPrompt(canonical)
    const sourceRefs = buildSourceRefs(group)

    out.push({
      signature: signature('command', slug),
      name: humanizeSlug(slug),
      description: firstLine(canonical),
      bodyDraft: canonical,
      suggestedType: 'command',
      score: 0, // Phase 5 ranks; detector emits unscored.
      sourceRefs,
      model,
      promptText: canonical,
      invocationCount: group.length,
      suggestedSlug: slug,
      evidenceQuotes: group.slice(0, 3).map(g => ({
        conversationId: g.conversationId,
        quote: g.text.slice(0, 200),
      })),
    })
  }

  return out
}

// ---- Heuristics -------------------------------------------------------------

/** Fraction of characters that look code/path-like. Used to drop prompts
 *  that are mostly file paths or fenced code rather than natural-language
 *  templates. Counts the full length of every fenced code block ONCE, plus
 *  code-like punctuation OUTSIDE fenced blocks. The previous version
 *  double-counted (fence-internal chars contributed via both fenceLen and
 *  hits), which silently dropped real prompts like
 *  "Refactor this: ```ts …``` to handle nulls" — a very common command shape. */
export function codeRatio(text: string): number {
  if (text.length === 0) return 0

  // Mark fence-internal char indices so the hit loop can skip them.
  const inFence = new Uint8Array(text.length)
  let fenceLen = 0
  const fenceRe = /```[\s\S]*?```/g
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(text)) != null) {
    fenceLen += m[0].length
    for (let i = m.index; i < m.index + m[0].length; i++) inFence[i] = 1
  }

  let hits = 0
  for (let i = 0; i < text.length; i++) {
    if (inFence[i]) continue
    const c = text[i]
    if (c === '/' || c === '.' || c === ':' || c === '`' || c === '_' || c === '{' || c === '}' || c === ';') hits++
  }

  return Math.min(1, (fenceLen + hits) / text.length)
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'i', 'you', 'we', 'they', 'me', 'my',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'this',
  'that', 'these', 'those', 'it', 'its', 'do', 'does', 'did', 'have', 'has',
  'had', 'can', 'could', 'should', 'would', 'will', 'just',
])

export function slugFromPrompt(prompt: string, maxWords = 5): string {
  const words = prompt
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const significant: string[] = []
  for (const w of words) {
    if (STOPWORDS.has(w)) continue
    if (significant.length >= maxWords) break
    significant.push(w)
  }
  const slug = significant.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return slug || 'untitled-command'
}

function humanizeSlug(slug: string): string {
  return slug.split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ')
}

function firstLine(text: string): string {
  const line = text.split('\n')[0].trim()
  return line.length > 160 ? line.slice(0, 157) + '…' : line
}

function buildSourceRefs(group: PromptOccurrence[]): CandidateSourceRef[] {
  const byConv = new Map<string, PromptOccurrence>()
  for (const g of group) if (!byConv.has(g.conversationId)) byConv.set(g.conversationId, g)
  return [...byConv.values()].map(g => ({
    source: g.source,
    conversationId: g.conversationId,
    excerpt: g.text.slice(0, 120),
    at: g.arcStartedAt,
  }))
}

function signature(type: string, slug: string): string {
  return crypto.createHash('sha256').update(`${type}::${slug}`).digest('hex').slice(0, 16)
}

export const __test = { codeRatio, slugFromPrompt, humanizeSlug, firstLine, signature }

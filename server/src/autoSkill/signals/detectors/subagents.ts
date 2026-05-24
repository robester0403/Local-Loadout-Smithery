// Detector D (LOC-76): Subagent candidates. Subagents are compositions of
// skills — recurring orchestration patterns inside individual conversations
// that complete a bounded outcome.
//
// Pipeline:
//   1. Build per-conversation arc sequences, each arc tagged with the skill
//      (existing or newly-proposed) it most resembles, or 'custom'.
//   2. Mine contiguous n-grams of length ≥ minPatternLength across
//      conversations.
//   3. Keep n-grams recurring across ≥ minPatternConvos distinct
//      conversations.
//   4. Subsumption pass: drop short patterns that always co-occur with a
//      longer pattern (the longer one is the real signal).
//   5. Bounded-shape check: the last arc of each instance must have
//      outcome === 'succeeded' for the majority of instances.
//   6. Synthesize per surviving pattern (1 LLM call): { name, description,
//      constituentSkills, orchestrationPattern, inputShape, outputShape }.
//   7. Emit as Candidate with suggestedType: 'subagent'.

import crypto from 'crypto'
import { generate } from '../../../ollama/client'
import type { Candidate, CandidateSourceRef } from '../../types'
import type { ConversationSummary } from '../types'

const CUSTOM_TAG = '__custom'
const DEFAULT_MIN_PATTERN_CONVOS = 3
const DEFAULT_MIN_PATTERN_LENGTH = 2
const DEFAULT_MAX_PATTERN_LENGTH = 6
const DEFAULT_SIMILARITY_THRESHOLD = 0.7
const DEFAULT_MIN_BOUNDED_SHAPE_RATIO = 0.66
const DEFAULT_MODEL = 'qwen2.5:3b'

export type GeneratedCandidate = Omit<Candidate, 'id' | 'status' | 'createdAt' | 'updatedAt'>

export interface SkillRef {
  name: string
  description: string
}

export type SubagentEmbedFn = (text: string) => Promise<number[]>
export type SubagentSynthFn = (prompt: string, model: string) => Promise<string>

export interface SubagentDetectorOptions {
  embedFn?: SubagentEmbedFn
  llmSynthFn?: SubagentSynthFn
  /** Pre-computed skill tag per arcId. When supplied, embedFn is bypassed.
   *  Tests use this to skip the embedding round-trip. */
  skillTags?: Map<string, string | null>
  similarityThreshold?: number
  minPatternConvos?: number
  minPatternLength?: number
  maxPatternLength?: number
  /** Fraction of pattern instances that must end with a successful arc to
   *  count as bounded. Default 2/3. */
  minBoundedShapeRatio?: number
  model?: string
}

export interface SubagentDetectorWarning {
  patternKey: string
  reason: 'unbounded-shape' | 'synth-invalid' | 'below-threshold'
  detail: string
}

export interface SubagentDetectorResult {
  candidates: GeneratedCandidate[]
  warnings: SubagentDetectorWarning[]
}

export async function detectSubagents(
  summaries: ConversationSummary[],
  availableSkills: SkillRef[],
  opts: SubagentDetectorOptions = {},
): Promise<SubagentDetectorResult> {
  const cfg = resolveOptions(opts)
  const warnings: SubagentDetectorWarning[] = []

  // 1. Skill-tag every arc (defaulting to 'custom').
  const tags = opts.skillTags
    ? new Map(opts.skillTags)
    : await tagArcsBySkill(summaries, availableSkills, cfg)

  // 2. Build per-conversation tagged sequences (chronological).
  const sequences = buildConversationSequences(summaries, tags)

  // 3 + 4. Mine recurring patterns + subsumption.
  const recurring = minePatterns(sequences, cfg)
  if (recurring.length === 0) return { candidates: [], warnings }

  // 5. Bounded-shape filter.
  const boundedPatterns: PatternRecurrence[] = []
  for (const r of recurring) {
    const boundedRatio = computeBoundedRatio(r)
    if (boundedRatio < cfg.minBoundedShapeRatio) {
      warnings.push({
        patternKey: r.key,
        reason: 'unbounded-shape',
        detail: `bounded ratio ${boundedRatio.toFixed(2)} < ${cfg.minBoundedShapeRatio}`,
      })
      continue
    }
    boundedPatterns.push(r)
  }

  if (boundedPatterns.length === 0) return { candidates: [], warnings }

  // 6 + 7. Synthesize and emit.
  const candidates: GeneratedCandidate[] = []
  for (const pat of boundedPatterns) {
    const synth = await synthesize(pat, summaries, cfg)
    if (!synth) {
      warnings.push({
        patternKey: pat.key,
        reason: 'synth-invalid',
        detail: 'LLM did not return a complete subagent definition',
      })
      continue
    }
    candidates.push(buildCandidate(pat, synth, summaries, cfg.model))
  }

  return { candidates, warnings }
}

// ---- Options ----------------------------------------------------------------

interface ResolvedOptions {
  embedFn: SubagentEmbedFn | undefined
  synthFn: SubagentSynthFn
  similarityThreshold: number
  minPatternConvos: number
  minPatternLength: number
  maxPatternLength: number
  minBoundedShapeRatio: number
  model: string
}

function resolveOptions(opts: SubagentDetectorOptions): ResolvedOptions {
  return {
    embedFn: opts.embedFn,
    synthFn: opts.llmSynthFn ?? defaultSynthFn,
    similarityThreshold: opts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD,
    minPatternConvos: opts.minPatternConvos ?? DEFAULT_MIN_PATTERN_CONVOS,
    minPatternLength: opts.minPatternLength ?? DEFAULT_MIN_PATTERN_LENGTH,
    maxPatternLength: opts.maxPatternLength ?? DEFAULT_MAX_PATTERN_LENGTH,
    minBoundedShapeRatio: opts.minBoundedShapeRatio ?? DEFAULT_MIN_BOUNDED_SHAPE_RATIO,
    model: opts.model ?? DEFAULT_MODEL,
  }
}

// ---- Skill tagging ----------------------------------------------------------

export async function tagArcsBySkill(
  summaries: ConversationSummary[],
  skills: SkillRef[],
  cfg: ResolvedOptions,
): Promise<Map<string, string | null>> {
  const tags = new Map<string, string | null>()
  const skillByName = new Map<string, SkillRef>()
  for (const s of skills) skillByName.set(s.name, s)

  // Embedding shortcut: precompute skill embeddings once if embedFn is given.
  const skillVectors: Array<{ skill: SkillRef; vec: number[] }> = []
  if (cfg.embedFn && skills.length > 0) {
    for (const s of skills) {
      const v = normalize(await cfg.embedFn(`${s.name}\n${s.description}`))
      skillVectors.push({ skill: s, vec: v })
    }
  }

  for (const s of summaries) {
    // 1. Direct skill name match via Phase-1 invokedSkills.
    const direct = s.invokedSkills.find(n => skillByName.has(n))
    if (direct) {
      tags.set(s.arcId, direct)
      continue
    }

    // 2. Embedding similarity vs all skills.
    if (cfg.embedFn && skillVectors.length > 0) {
      const arcVec = normalize(await cfg.embedFn(`${s.intent}\n${s.resolutionSteps.join('\n')}`))
      let bestName: string | null = null
      let bestSim = -Infinity
      for (const sv of skillVectors) {
        const sim = dot(arcVec, sv.vec)
        if (sim > bestSim) {
          bestSim = sim
          bestName = sv.skill.name
        }
      }
      tags.set(s.arcId, bestSim >= cfg.similarityThreshold ? bestName : null)
      continue
    }

    tags.set(s.arcId, null)
  }
  return tags
}

// ---- Conversation sequences ------------------------------------------------

interface SequenceArc {
  arcId: string
  tag: string // skill name or CUSTOM_TAG
  outcome: ConversationSummary['outcome']
}

interface ConversationSequence {
  conversationId: string
  arcs: SequenceArc[]
}

function buildConversationSequences(
  summaries: ConversationSummary[],
  tags: Map<string, string | null>,
): ConversationSequence[] {
  const byConv = new Map<string, ConversationSummary[]>()
  for (const s of summaries) {
    const arr = byConv.get(s.conversationId) ?? []
    arr.push(s)
    byConv.set(s.conversationId, arr)
  }
  const out: ConversationSequence[] = []
  for (const [conversationId, arr] of byConv.entries()) {
    arr.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    out.push({
      conversationId,
      arcs: arr.map(s => ({
        arcId: s.arcId,
        tag: tags.get(s.arcId) ?? CUSTOM_TAG,
        outcome: s.outcome,
      })),
    })
  }
  return out
}

// ---- Pattern mining ---------------------------------------------------------

export interface PatternInstance {
  conversationId: string
  startArcId: string
  endArcId: string
  endOutcome: ConversationSummary['outcome']
}

export interface PatternRecurrence {
  key: string                // joined tags, e.g. "skillA||skillB"
  tags: string[]
  instances: PatternInstance[]
}

function minePatterns(
  sequences: ConversationSequence[],
  cfg: ResolvedOptions,
): PatternRecurrence[] {
  const byKey = new Map<string, PatternRecurrence>()

  for (const seq of sequences) {
    for (let i = 0; i < seq.arcs.length; i++) {
      for (let len = cfg.minPatternLength; len <= cfg.maxPatternLength; len++) {
        if (i + len > seq.arcs.length) break
        const slice = seq.arcs.slice(i, i + len)
        // Reject all-custom windows — no orchestration signal.
        if (slice.every(a => a.tag === CUSTOM_TAG)) continue
        const tags = slice.map(a => a.tag)
        // Reject single-skill loops like [A, A] / [A, A, A] — not orchestration.
        if (new Set(tags).size === 1) continue
        const key = tags.join('||')
        const rec = byKey.get(key) ?? { key, tags, instances: [] }
        rec.instances.push({
          conversationId: seq.conversationId,
          startArcId: slice[0].arcId,
          endArcId: slice[slice.length - 1].arcId,
          endOutcome: slice[slice.length - 1].outcome,
        })
        byKey.set(key, rec)
      }
    }
  }

  // Threshold: ≥ minPatternConvos distinct conversations.
  const surviving: PatternRecurrence[] = []
  for (const r of byKey.values()) {
    const distinct = new Set(r.instances.map(i => i.conversationId))
    if (distinct.size >= cfg.minPatternConvos) surviving.push(r)
  }

  return subsumptionDedup(surviving)
}

/** Drop short patterns whose distinct-conv set is fully contained inside a
 *  longer pattern's set AND the longer pattern's tags contain the short
 *  pattern's tags as a contiguous slice. The longer one is the real signal. */
function subsumptionDedup(patterns: PatternRecurrence[]): PatternRecurrence[] {
  const byLength = [...patterns].sort((a, b) => b.tags.length - a.tags.length)
  const kept: PatternRecurrence[] = []
  for (const p of byLength) {
    const pConvs = new Set(p.instances.map(i => i.conversationId))
    let subsumed = false
    for (const k of kept) {
      if (k.tags.length <= p.tags.length) continue
      if (!containsSubsequence(k.tags, p.tags)) continue
      const kConvs = new Set(k.instances.map(i => i.conversationId))
      if ([...pConvs].every(c => kConvs.has(c))) {
        subsumed = true
        break
      }
    }
    if (!subsumed) kept.push(p)
  }
  return kept
}

function containsSubsequence(haystack: string[], needle: string[]): boolean {
  if (needle.length > haystack.length) return false
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let match = true
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { match = false; break }
    }
    if (match) return true
  }
  return false
}

// ---- Bounded-shape ----------------------------------------------------------

function computeBoundedRatio(pattern: PatternRecurrence): number {
  if (pattern.instances.length === 0) return 0
  const succeeded = pattern.instances.filter(i => i.endOutcome === 'succeeded').length
  return succeeded / pattern.instances.length
}

// ---- Synthesis --------------------------------------------------------------

export interface SubagentSynthOutput {
  name: string
  description: string
  constituentSkills: string[]
  orchestrationPattern: string[]
  inputShape: string
  outputShape: string
}

async function synthesize(
  pattern: PatternRecurrence,
  summaries: ConversationSummary[],
  cfg: ResolvedOptions,
): Promise<SubagentSynthOutput | null> {
  const prompt = buildSynthPrompt(pattern, summaries)
  let raw: string
  try {
    raw = await cfg.synthFn(prompt, cfg.model)
  } catch {
    return null
  }
  return parseSynthOutput(raw, pattern)
}

export function buildSynthPrompt(
  pattern: PatternRecurrence,
  summaries: ConversationSummary[],
): string {
  const byArc = new Map(summaries.map(s => [s.arcId, s]))
  const exampleLines = pattern.instances.slice(0, 3).map((inst, i) => {
    const start = byArc.get(inst.startArcId)
    const end = byArc.get(inst.endArcId)
    return [
      `[${i + 1}] conv: ${inst.conversationId}`,
      `    start intent: ${start?.intent ?? '(unknown)'}`,
      `    end intent:   ${end?.intent ?? '(unknown)'}`,
      `    end outcome:  ${inst.endOutcome}`,
    ].join('\n')
  }).join('\n\n')

  return [
    'You are turning a recurring orchestration pattern into a SUBAGENT definition.',
    'A subagent composes existing skills (and/or custom work) toward a bounded outcome.',
    '',
    `Pattern (ordered skill tags, "${CUSTOM_TAG}" = arc that didn't map to any known skill):`,
    `  ${pattern.tags.join(' → ')}`,
    `Recurrence: ${new Set(pattern.instances.map(i => i.conversationId)).size} distinct conversations.`,
    '',
    'Example instances:',
    exampleLines || '  (none)',
    '',
    'Return STRICT JSON, no prose, no markdown:',
    '{',
    '  "name": string (short kebab-case slug, 2-5 words),',
    '  "description": string (one sentence — what bounded outcome this subagent produces),',
    '  "constituentSkills": string[] (the named skills it orchestrates; exclude "__custom"),',
    '  "orchestrationPattern": string[] (ordered, human-readable steps describing what the subagent does),',
    '  "inputShape": string (what the subagent expects as input),',
    '  "outputShape": string (what the subagent produces)',
    '}',
  ].join('\n')
}

export function parseSynthOutput(raw: string, pattern: PatternRecurrence): SubagentSynthOutput | null {
  let obj: unknown
  try { obj = JSON.parse(raw) } catch { return null }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>

  const name = strOrNull(o['name'])
  const description = strOrNull(o['description'])
  const constituentSkills = strArrayOrNull(o['constituentSkills'])
  const orchestrationPattern = strArrayOrNull(o['orchestrationPattern'])
  const inputShape = strOrNull(o['inputShape'])
  const outputShape = strOrNull(o['outputShape'])

  if (!name || !description || !inputShape || !outputShape) return null
  if (!orchestrationPattern || orchestrationPattern.length === 0) return null

  // If the LLM didn't echo constituent skills, fall back to the pattern's
  // named tags (sans CUSTOM_TAG) so the UI still has something to display.
  const skills = constituentSkills && constituentSkills.length > 0
    ? constituentSkills.filter(s => s !== CUSTOM_TAG)
    : pattern.tags.filter(t => t !== CUSTOM_TAG)

  return {
    name,
    description,
    constituentSkills: skills,
    orchestrationPattern,
    inputShape,
    outputShape,
  }
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

function strArrayOrNull(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const x of v) {
    if (typeof x === 'string' && x.trim().length > 0) out.push(x.trim())
  }
  return out
}

const defaultSynthFn: SubagentSynthFn = async (prompt, model) => {
  return generate({ model, prompt, json: true, temperature: 0.2, timeoutMs: 120_000 })
}

// ---- Candidate construction -------------------------------------------------

function buildCandidate(
  pattern: PatternRecurrence,
  synth: SubagentSynthOutput,
  summaries: ConversationSummary[],
  model: string,
): GeneratedCandidate {
  const slug = sanitizeSlug(synth.name)
  const byArc = new Map(summaries.map(s => [s.arcId, s]))
  const distinctConvs = new Map<string, ConversationSummary>()
  for (const inst of pattern.instances) {
    const start = byArc.get(inst.startArcId)
    if (start && !distinctConvs.has(inst.conversationId)) {
      distinctConvs.set(inst.conversationId, start)
    }
  }
  const sourceRefs: CandidateSourceRef[] = [...distinctConvs.values()].slice(0, 5).map(s => ({
    source: s.source,
    conversationId: s.conversationId,
    excerpt: s.intent.slice(0, 120),
    at: s.startedAt,
  }))

  const evidenceQuotes = pattern.instances.slice(0, 3).map(inst => ({
    conversationId: inst.conversationId,
    quote: `${pattern.tags.join(' → ')} (end outcome: ${inst.endOutcome})`,
  }))

  return {
    signature: signature('subagent', slug),
    name: synth.name,
    description: synth.description,
    bodyDraft: renderSubagentBody(synth),
    suggestedType: 'subagent',
    score: 0,
    sourceRefs,
    model,
    constituentSkills: synth.constituentSkills,
    orchestrationPattern: synth.orchestrationPattern,
    inputShape: synth.inputShape,
    outputShape: synth.outputShape,
    evidenceQuotes,
    sourceClusterId: `subagent-pattern::${pattern.key}`,
  }
}

export function renderSubagentBody(synth: SubagentSynthOutput): string {
  return [
    '## Input',
    synth.inputShape,
    '',
    '## Constituent skills',
    ...synth.constituentSkills.map(s => `- ${s}`),
    '',
    '## Orchestration',
    ...synth.orchestrationPattern.map((s, i) => `${i + 1}. ${s}`),
    '',
    '## Output',
    synth.outputShape,
    '',
  ].join('\n')
}

function sanitizeSlug(name: string): string {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'untitled-subagent'
}

function signature(type: string, slug: string): string {
  return crypto.createHash('sha256').update(`${type}::${slug}`).digest('hex').slice(0, 16)
}

// ---- Vector helpers (local — cluster.ts imports embed which would pull
//                     the disk cache into this module's deps unnecessarily) ----

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

// Test seam
export const __test = {
  minePatterns,
  subsumptionDedup,
  containsSubsequence,
  buildConversationSequences,
  tagArcsBySkill,
  parseSynthOutput,
  renderSubagentBody,
  sanitizeSlug,
  CUSTOM_TAG,
}

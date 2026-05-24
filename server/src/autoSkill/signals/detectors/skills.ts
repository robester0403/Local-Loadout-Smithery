// Detector C (LOC-75): Skill candidates. Strict bar — skills auto-load on
// description match, so a noisy candidate costs real tokens on every
// conversation. Each candidate is shaped as the formal S = (C, π, T, R)
// tuple per arXiv 2602.20867 and validated by a programmatic consistency
// check (NSI-style, arXiv 2605.01293).
//
// Cost: ~0 LLM calls for clusters that fail pre-filters; 1 synth call + 1
// consistency batch per surviving cluster. Synth retries once on malformed
// output, then drops the candidate.

import crypto from 'crypto'
import { generate } from '../../../ollama/client'
import type { Candidate, CandidateSourceRef } from '../../types'
import type { ConversationSummary, IntentCluster } from '../types'

const DEFAULT_MIN_RECURRENCE = 3
const DEFAULT_MIN_SUCCESS_RATE = 0.6
const DEFAULT_MIN_CONVERGENT_STEPS = 3
const DEFAULT_MIN_STABLE_MAJORITY = 0.5
const DEFAULT_MIN_HOLDOUT_PASSES = 1
const DEFAULT_MAX_SYNTH_RETRIES = 1
const DEFAULT_MODEL = 'qwen2.5:3b'
const HOLDOUT_COUNT = 2
const MAX_SYNTH_MEMBERS = 3

export type GeneratedCandidate = Omit<Candidate, 'id' | 'status' | 'createdAt' | 'updatedAt'>

export type SkillSynthFn = (prompt: string, model: string) => Promise<string>
export type SkillConsistencyFn = (prompt: string, model: string) => Promise<string>

export interface SkillDetectorOptions {
  llmSynthFn?: SkillSynthFn
  llmConsistencyFn?: SkillConsistencyFn
  minRecurrence?: number
  minSuccessRate?: number
  minConvergentSteps?: number
  minStableMajority?: number
  minHoldoutPasses?: number
  maxSynthRetries?: number
  model?: string
}

export interface SkillDetectorWarning {
  clusterId: string
  reason: 'pre-filter' | 'synth-invalid' | 'consistency-failed' | 'too-few-members'
  detail: string
}

export interface SkillDetectorResult {
  candidates: GeneratedCandidate[]
  warnings: SkillDetectorWarning[]
}

export async function detectSkills(
  clusters: IntentCluster[],
  summaries: ConversationSummary[],
  opts: SkillDetectorOptions = {},
): Promise<SkillDetectorResult> {
  const cfg = resolveOptions(opts)
  const byArc = indexByArc(summaries)
  const candidates: GeneratedCandidate[] = []
  const warnings: SkillDetectorWarning[] = []

  for (const cluster of clusters) {
    const members = cluster.members
      .map(id => byArc.get(id))
      .filter((m): m is ConversationSummary => m != null)

    const pre = preFilter(cluster, members, cfg)
    if (!pre.ok) {
      warnings.push({ clusterId: cluster.clusterId, reason: 'pre-filter', detail: pre.reason })
      continue
    }

    // Reserve 2 members for the consistency holdout; remainder feeds synthesis.
    if (members.length < HOLDOUT_COUNT + 1) {
      warnings.push({
        clusterId: cluster.clusterId,
        reason: 'too-few-members',
        detail: `need ≥${HOLDOUT_COUNT + 1} members for holdout, have ${members.length}`,
      })
      continue
    }
    const holdouts = members.slice(-HOLDOUT_COUNT)
    const synthMembers = members.slice(0, Math.min(MAX_SYNTH_MEMBERS, members.length - HOLDOUT_COUNT))

    const synth = await synthesizeWithRetry(cluster, synthMembers, cfg)
    if (!synth) {
      warnings.push({
        clusterId: cluster.clusterId,
        reason: 'synth-invalid',
        detail: 'LLM did not return a complete S-tuple after retries',
      })
      continue
    }

    const consistency = await runConsistencyCheck(synth, holdouts, cfg)
    const passCount = consistency.holdouts.filter(h => h.pass).length
    if (passCount < cfg.minHoldoutPasses) {
      warnings.push({
        clusterId: cluster.clusterId,
        reason: 'consistency-failed',
        detail: `${passCount}/${holdouts.length} holdouts passed (need ≥${cfg.minHoldoutPasses})`,
      })
      continue
    }

    candidates.push(buildCandidate(cluster, synth, members, holdouts, consistency, cfg.model))
  }

  return { candidates, warnings }
}

// ---- Pre-filter -------------------------------------------------------------

interface ResolvedOptions {
  minRecurrence: number
  minSuccessRate: number
  minConvergentSteps: number
  minStableMajority: number
  minHoldoutPasses: number
  maxSynthRetries: number
  model: string
  synthFn: SkillSynthFn
  consistencyFn: SkillConsistencyFn
}

function resolveOptions(opts: SkillDetectorOptions): ResolvedOptions {
  return {
    minRecurrence: opts.minRecurrence ?? DEFAULT_MIN_RECURRENCE,
    minSuccessRate: opts.minSuccessRate ?? DEFAULT_MIN_SUCCESS_RATE,
    minConvergentSteps: opts.minConvergentSteps ?? DEFAULT_MIN_CONVERGENT_STEPS,
    minStableMajority: opts.minStableMajority ?? DEFAULT_MIN_STABLE_MAJORITY,
    minHoldoutPasses: opts.minHoldoutPasses ?? DEFAULT_MIN_HOLDOUT_PASSES,
    maxSynthRetries: opts.maxSynthRetries ?? DEFAULT_MAX_SYNTH_RETRIES,
    model: opts.model ?? DEFAULT_MODEL,
    synthFn: opts.llmSynthFn ?? defaultSynthFn,
    consistencyFn: opts.llmConsistencyFn ?? defaultConsistencyFn,
  }
}

function preFilter(
  cluster: IntentCluster,
  members: ConversationSummary[],
  cfg: ResolvedOptions,
): { ok: true } | { ok: false; reason: string } {
  if (cluster.recurrenceCount < cfg.minRecurrence) {
    return { ok: false, reason: `recurrence ${cluster.recurrenceCount} < ${cfg.minRecurrence}` }
  }
  const total = cluster.outcomeBreakdown.succeeded + cluster.outcomeBreakdown.failed
    + cluster.outcomeBreakdown.abandoned + cluster.outcomeBreakdown.partial
  const rate = total > 0 ? cluster.outcomeBreakdown.succeeded / total : 0
  if (rate < cfg.minSuccessRate) {
    return { ok: false, reason: `success rate ${rate.toFixed(2)} < ${cfg.minSuccessRate}` }
  }
  if (cluster.convergentApproach.length < cfg.minConvergentSteps) {
    return {
      ok: false,
      reason: `convergentApproach ${cluster.convergentApproach.length} < ${cfg.minConvergentSteps}`,
    }
  }
  if (members.length === 0) {
    return { ok: false, reason: 'no summaries found for any cluster member' }
  }
  const stableCount = members.filter(m => m.stableApproach).length
  const stableRatio = stableCount / members.length
  if (stableRatio < cfg.minStableMajority) {
    return {
      ok: false,
      reason: `stableApproach majority ${stableRatio.toFixed(2)} < ${cfg.minStableMajority}`,
    }
  }
  return { ok: true }
}

// ---- Synthesis --------------------------------------------------------------

export interface SkillSynthOutput {
  name: string
  description: string
  applicabilityCondition: string
  procedure: string[]
  terminationCondition: string
  expectedOutput: string
}

async function synthesizeWithRetry(
  cluster: IntentCluster,
  synthMembers: ConversationSummary[],
  cfg: ResolvedOptions,
): Promise<SkillSynthOutput | null> {
  const prompt = buildSynthPrompt(cluster, synthMembers)
  for (let attempt = 0; attempt <= cfg.maxSynthRetries; attempt++) {
    let raw: string
    try {
      raw = await cfg.synthFn(prompt, cfg.model)
    } catch {
      continue
    }
    const parsed = parseSynthOutput(raw)
    if (parsed) return parsed
  }
  return null
}

export function buildSynthPrompt(
  cluster: IntentCluster,
  synthMembers: ConversationSummary[],
): string {
  const slotLines = Object.keys(cluster.centroidSlotValues)
    .sort()
    .map(k => {
      const vals = cluster.centroidSlotValues[k] ?? []
      return vals.length ? `  ${k}: ${vals.join(', ')}` : null
    })
    .filter((s): s is string => s != null)

  const memberLines = synthMembers.map((m, i) => {
    const steps = m.resolutionSteps.length
      ? m.resolutionSteps.map(s => `      - ${s}`).join('\n')
      : '      (none)'
    return [
      `  [${i + 1}] intent: ${m.intent}`,
      `      outcome: ${m.outcome}`,
      `      resolutionSteps:`,
      steps,
    ].join('\n')
  }).join('\n')

  return [
    'You are turning a recurring developer workflow into a SKILL with the formal structure S = (C, π, T, R):',
    '  C = applicabilityCondition: when should this skill be invoked?',
    '  π = procedure: ordered steps, concrete and verb-led',
    '  T = terminationCondition: how do you know the skill is finished?',
    '  R = expectedOutput: what does success look like?',
    '',
    `Recurring intent: ${cluster.centroidIntent}`,
    `Recurrence: ${cluster.recurrenceCount} sessions over ${cluster.dateSpan.start} → ${cluster.dateSpan.end}`,
    `Common tool signature: ${cluster.commonToolSignature.join(', ') || '(none)'}`,
    `Convergent approach (steps the user actually took across all sessions):`,
    cluster.convergentApproach.map(s => `  - ${s}`).join('\n') || '  (none)',
    slotLines.length ? `Slot values:` : '',
    ...slotLines,
    '',
    'Representative sessions:',
    memberLines || '  (none)',
    '',
    'Return STRICT JSON, no prose, no markdown:',
    '{',
    '  "name": string (short kebab-case slug, 2-5 words),',
    '  "description": string (one sentence purpose),',
    '  "applicabilityCondition": string,',
    '  "procedure": string[] (ordered, ≥ 2 entries),',
    '  "terminationCondition": string,',
    '  "expectedOutput": string',
    '}',
  ].filter(Boolean).join('\n')
}

export function parseSynthOutput(raw: string): SkillSynthOutput | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>

  const name = strOrNull(o['name'])
  const description = strOrNull(o['description'])
  const applicabilityCondition = strOrNull(o['applicabilityCondition'])
  const procedure = strArrayOrNull(o['procedure'])
  const terminationCondition = strOrNull(o['terminationCondition'])
  const expectedOutput = strOrNull(o['expectedOutput'])

  if (!name || !description || !applicabilityCondition || !terminationCondition || !expectedOutput) return null
  if (!procedure || procedure.length === 0) return null

  return { name, description, applicabilityCondition, procedure, terminationCondition, expectedOutput }
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
  return out.length > 0 ? out : null
}

const defaultSynthFn: SkillSynthFn = async (prompt, model) => {
  return generate({ model, prompt, json: true, temperature: 0.2, timeoutMs: 120_000 })
}

// ---- Consistency check ------------------------------------------------------

export interface ConsistencyHoldout {
  conversationId: string
  arcId: string
  pass: boolean
  reason: string
}

export interface ConsistencyResult {
  holdouts: ConsistencyHoldout[]
}

async function runConsistencyCheck(
  skill: SkillSynthOutput,
  holdouts: ConversationSummary[],
  cfg: ResolvedOptions,
): Promise<ConsistencyResult> {
  if (holdouts.length === 0) return { holdouts: [] }
  const prompt = buildConsistencyPrompt(skill, holdouts)
  let raw = ''
  try {
    raw = await cfg.consistencyFn(prompt, cfg.model)
  } catch {
    return { holdouts: holdouts.map(h => ({
      conversationId: h.conversationId,
      arcId: h.arcId,
      pass: false,
      reason: 'consistency LLM call failed',
    })) }
  }
  const parsed = parseConsistencyOutput(raw, holdouts)
  return { holdouts: parsed }
}

export function buildConsistencyPrompt(
  skill: SkillSynthOutput,
  holdouts: ConversationSummary[],
): string {
  const skillBlock = [
    `Name: ${skill.name}`,
    `Description: ${skill.description}`,
    `Applicability (C): ${skill.applicabilityCondition}`,
    `Procedure (π):`,
    ...skill.procedure.map((s, i) => `  ${i + 1}. ${s}`),
    `Termination (T): ${skill.terminationCondition}`,
    `Expected output (R): ${skill.expectedOutput}`,
  ].join('\n')

  const holdoutLines = holdouts.map((h, i) => {
    const steps = h.resolutionSteps.length
      ? h.resolutionSteps.map(s => `      - ${s}`).join('\n')
      : '      (none)'
    return [
      `[${i + 1}] intent: ${h.intent}`,
      `    outcome: ${h.outcome}`,
      `    resolutionSteps:`,
      steps,
    ].join('\n')
  }).join('\n\n')

  return [
    'Consistency check: would the following candidate skill, if applied to each held-out session, produce a similar outcome to what actually happened?',
    '',
    'Candidate skill:',
    skillBlock,
    '',
    'Held-out sessions (NOT used to synthesize the skill):',
    holdoutLines,
    '',
    'Return STRICT JSON:',
    '{ "holdouts": [ { "pass": boolean, "reason": string } ] }',
    '',
    'One entry per held-out session, in order. `pass: true` iff applying the skill would produce a similar outcome.',
  ].join('\n')
}

export function parseConsistencyOutput(
  raw: string,
  holdouts: ConversationSummary[],
): ConsistencyHoldout[] {
  let obj: unknown
  try { obj = JSON.parse(raw) } catch { return failAll(holdouts, 'invalid JSON from consistency LLM') }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return failAll(holdouts, 'non-object JSON from consistency LLM')
  }
  const arr = (obj as { holdouts?: unknown }).holdouts
  if (!Array.isArray(arr)) return failAll(holdouts, 'missing holdouts array')

  return holdouts.map((h, i) => {
    const entry = arr[i]
    if (!entry || typeof entry !== 'object') {
      return { conversationId: h.conversationId, arcId: h.arcId, pass: false, reason: 'missing entry' }
    }
    const e = entry as Record<string, unknown>
    const pass = e['pass'] === true
    const reason = typeof e['reason'] === 'string' ? (e['reason'] as string) : ''
    return { conversationId: h.conversationId, arcId: h.arcId, pass, reason }
  })
}

function failAll(holdouts: ConversationSummary[], reason: string): ConsistencyHoldout[] {
  return holdouts.map(h => ({
    conversationId: h.conversationId,
    arcId: h.arcId,
    pass: false,
    reason,
  }))
}

const defaultConsistencyFn: SkillConsistencyFn = async (prompt, model) => {
  return generate({ model, prompt, json: true, temperature: 0.1, timeoutMs: 120_000 })
}

// ---- Candidate construction -------------------------------------------------

function buildCandidate(
  cluster: IntentCluster,
  synth: SkillSynthOutput,
  members: ConversationSummary[],
  holdouts: ConversationSummary[],
  consistency: ConsistencyResult,
  model: string,
): GeneratedCandidate {
  const slug = sanitizeSlug(synth.name)
  const sourceRefs: CandidateSourceRef[] = holdouts.map(h => ({
    source: h.source,
    conversationId: h.conversationId,
    excerpt: h.intent.slice(0, 120),
    at: h.startedAt,
  }))
  const evidenceQuotes = consistency.holdouts.map(h => ({
    conversationId: h.conversationId,
    quote: `[holdout ${h.pass ? 'pass' : 'fail'}] ${h.reason || '(no reason given)'}`.slice(0, 200),
  }))

  const example = pickExampleQuote(members)

  return {
    signature: signature('skill', slug),
    name: synth.name,
    description: synth.description,
    bodyDraft: renderSkillBody(synth, example),
    suggestedType: 'skill',
    score: 0,
    sourceRefs,
    model,
    applicabilityCondition: synth.applicabilityCondition,
    procedure: synth.procedure,
    terminationCondition: synth.terminationCondition,
    expectedOutput: synth.expectedOutput,
    evidenceQuotes,
    sourceClusterId: cluster.clusterId,
  }
}

export interface SkillBodyExample {
  prompt: string
  outcome: ConversationSummary['outcome']
}

/**
 * Pick a concrete user prompt to quote in the skill body's ## Example
 * section. Prefers successful arcs (so the example doesn't celebrate a
 * failure) and within those picks the longest prompt (more decision-making
 * fuel for the runtime LLM). Returns null when no usable prompt exists.
 *
 * Per arXiv finding (Claude Code skills authoring): "concise stepwise
 * guidance with at least one working example is often more effective than
 * exhaustive documentation." This is the cheap version of that — a single
 * verbatim quote appended to the body. The expensive version (QA-CoT body
 * generation per arXiv 2502.17321) weaves the example into the procedure
 * itself; tracked as a future-work ticket.
 */
export function pickExampleQuote(members: ConversationSummary[]): SkillBodyExample | null {
  let best: SkillBodyExample | null = null
  for (const m of members) {
    if (m.outcome !== 'succeeded') continue
    for (const p of m.verbatimUserPrompts) {
      const trimmed = p.trim()
      if (trimmed.length === 0) continue
      if (best == null || trimmed.length > best.prompt.length) {
        best = { prompt: trimmed, outcome: m.outcome }
      }
    }
  }
  return best
}

export function renderSkillBody(synth: SkillSynthOutput, example?: SkillBodyExample | null): string {
  const lines: string[] = [
    '## When to use',
    synth.applicabilityCondition,
    '',
    '## Procedure',
    ...synth.procedure.map((s, i) => `${i + 1}. ${s}`),
    '',
    '## When done',
    synth.terminationCondition,
    '',
    '## Expected output',
    synth.expectedOutput,
    '',
  ]
  if (example) {
    // Cap the quoted prompt so a 4kb verbatim doesn't dominate the body.
    const quoted = example.prompt.length > 600
      ? example.prompt.slice(0, 600) + '…'
      : example.prompt
    lines.push(
      '## Example',
      'A real user prompt that triggered this skill:',
      '',
      ...quoted.split('\n').map(l => `> ${l}`),
      '',
      `Observed outcome: ${example.outcome}.`,
      '',
    )
  }
  return lines.join('\n')
}

function sanitizeSlug(name: string): string {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'untitled-skill'
}

function signature(type: string, slug: string): string {
  return crypto.createHash('sha256').update(`${type}::${slug}`).digest('hex').slice(0, 16)
}

function indexByArc(summaries: ConversationSummary[]): Map<string, ConversationSummary> {
  const m = new Map<string, ConversationSummary>()
  for (const s of summaries) m.set(s.arcId, s)
  return m
}

// Test seam
export const __test = {
  preFilter,
  parseSynthOutput,
  parseConsistencyOutput,
  renderSkillBody,
  pickExampleQuote,
  sanitizeSlug,
  signature,
  resolveOptions,
}

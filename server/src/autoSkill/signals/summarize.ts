// Phase 1 of the signal-detection pipeline (LOC-69 / LOC-72): summarize one
// sub-goal arc into a structured `ConversationSummary`. Small-model LLM call
// (qwen2.5:3b by default), JSON-formatted output, manually validated.
//
// Per arXiv 2502.17321 (Choubey et al.), clustering on extracted procedural
// elements outperforms clustering on raw text — this phase produces those
// elements. The downstream Phase 2 clusterer (LOC-73) embeds intent + slots.
//
// Cache lookup happens before the LLM call. Failed-and-exploratory arcs are
// filtered to `null` and not cached (they may stabilize on a future run).

import { generate } from '../../ollama/client'
import type { ConversationRecord } from '../../extractors/types'
import { computeCacheKey, openSummaryCache, type SummaryCache } from './summaryCache'
import type { ConversationSummary, SubGoalArc } from './types'

const DEFAULT_MODEL = 'qwen2.5:3b'
const PROMPT_TURN_TRUNCATE = 1200 // per-turn char cap inside the prompt
const PROMPT_TOTAL_CAP = 12_000   // hard ceiling on total prompt body

export type LlmSummarizeFn = (prompt: string, model: string) => Promise<string>

export interface SummarizeOptions {
  /** Override the LLM call (tests). Defaults to Ollama `generate` JSON mode. */
  llmFn?: LlmSummarizeFn
  /** Override the model. Default 'qwen2.5:3b'. */
  model?: string
  /** Provide a cache instance. Defaults to the on-disk cache under ~/.loadoutsmith. */
  cache?: SummaryCache
}

/**
 * Summarize one arc. Returns `null` when the arc is filtered out (failed +
 * exploratory — no skill signal there per the audit). Cache is consulted
 * first; only successful summaries are written back.
 */
export async function summarizeArc(
  arc: SubGoalArc,
  conversation: ConversationRecord,
  opts: SummarizeOptions = {},
): Promise<ConversationSummary | null> {
  const cache = opts.cache ?? openSummaryCache()
  const key = computeCacheKey(arc, conversation)

  const hit = cache.get(key)
  if (hit) return hit

  const model = opts.model ?? DEFAULT_MODEL
  const llm = opts.llmFn ?? defaultLlm
  const prompt = buildPrompt(arc, conversation)

  const raw = await llm(prompt, model)
  const summary = parseSummary(raw, arc, conversation)

  if (shouldFilter(summary)) return null

  cache.set(key, summary)
  return summary
}

// ---- Filter -----------------------------------------------------------------

export function shouldFilter(summary: ConversationSummary): boolean {
  // Failed + unstable = exploratory dead-end. No skill signal here.
  return summary.outcome === 'failed' && summary.stableApproach === false
}

// ---- Prompt construction ----------------------------------------------------

export function buildPrompt(arc: SubGoalArc, conversation: ConversationRecord): string {
  const turns: string[] = []
  let used = 0
  for (let i = arc.startTurnIndex; i <= arc.endTurnIndex; i++) {
    const m = conversation.messages[i]
    if (!m) continue
    const body = m.content.length > PROMPT_TURN_TRUNCATE
      ? m.content.slice(0, PROMPT_TURN_TRUNCATE) + '…'
      : m.content
    const line = `[${i}] ${m.role.toUpperCase()}: ${body}`
    if (used + line.length > PROMPT_TOTAL_CAP) {
      turns.push(`[…${arc.endTurnIndex - i + 1} turns truncated…]`)
      break
    }
    turns.push(line)
    used += line.length + 1
  }

  return [
    'You are summarizing ONE sub-goal arc from a coding-assistant conversation.',
    'Return STRICT JSON matching the schema. No prose, no markdown — JSON only.',
    '',
    'Schema:',
    '{',
    '  "intent": string (one sentence describing what the user was trying to accomplish in this arc),',
    '  "slotValues": { "files": string[], "tools": string[], "libraries": string[], "mcps": string[] },',
    '  "resolutionSteps": string[] (the procedure the conversation converged on),',
    '  "outcome": "succeeded" | "failed" | "abandoned" | "partial",',
    '  "stableApproach": boolean (did the user pick one approach and stick with it?),',
    '  "subGoals": string[] (sub-tasks pursued within this arc),',
    '  "toolSignature": string[] (names of tools that appeared in this arc),',
    '  "invokedSkills": string[] (skills referenced by /<name> or "use the X skill"),',
    '  "verbatimUserPrompts": string[] (notable user messages, deduped),',
    '  "correctionMarkers": [{ "quote": string, "kind": "frustration" | "reversal" }],',
    '  "personalizationSignals": [{ "kind": string, "evidence": string }]',
    '}',
    '',
    'Conversation source: ' + conversation.source,
    'Arc range: turns ' + arc.startTurnIndex + '–' + arc.endTurnIndex + ' of ' + conversation.messages.length,
    '',
    'Turns:',
    turns.join('\n'),
  ].join('\n')
}

// ---- Default LLM call -------------------------------------------------------

const defaultLlm: LlmSummarizeFn = async (prompt, model) => {
  return generate({ model, prompt, json: true, temperature: 0.2, timeoutMs: 120_000 })
}

// ---- Schema parsing ---------------------------------------------------------

export function parseSummary(
  rawJson: string,
  arc: SubGoalArc,
  conversation: ConversationRecord,
): ConversationSummary {
  let obj: unknown
  try {
    obj = JSON.parse(rawJson)
  } catch (err) {
    throw new Error(
      `Summary LLM returned invalid JSON for arc ${arc.arcId}: ${(err as Error).message}`,
    )
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`Summary LLM returned non-object JSON for arc ${arc.arcId}`)
  }
  const o = obj as Record<string, unknown>

  const intent = expectString(o, 'intent', arc.arcId)
  const slotValues = expectSlotValues(o['slotValues'], arc.arcId)
  const resolutionSteps = expectStringArray(o, 'resolutionSteps', arc.arcId)
  const outcome = expectOutcome(o['outcome'], arc.arcId)
  const stableApproach = expectBool(o, 'stableApproach', arc.arcId)
  const subGoals = expectStringArray(o, 'subGoals', arc.arcId)
  const toolSignature = expectStringArray(o, 'toolSignature', arc.arcId)
  const invokedSkills = expectStringArray(o, 'invokedSkills', arc.arcId)
  const verbatimUserPrompts = expectStringArray(o, 'verbatimUserPrompts', arc.arcId)
  const correctionMarkers = expectCorrectionMarkers(o['correctionMarkers'], arc.arcId)
  const personalizationSignals = expectPersonalizationSignals(o['personalizationSignals'], arc.arcId)

  const firstTurn = conversation.messages[arc.startTurnIndex]

  return {
    arcId: arc.arcId,
    conversationId: arc.conversationId,
    source: conversation.source,
    startedAt: firstTurn?.timestamp ?? conversation.startedAt,
    intent,
    slotValues,
    resolutionSteps,
    outcome,
    stableApproach,
    subGoals,
    toolSignature,
    invokedSkills,
    verbatimUserPrompts,
    correctionMarkers,
    personalizationSignals,
  }
}

// ---- Validators -------------------------------------------------------------

function expectString(o: Record<string, unknown>, field: string, arcId: string): string {
  const v = o[field]
  if (typeof v !== 'string') {
    throw new Error(`Summary for arc ${arcId} missing string field '${field}'`)
  }
  return v
}

function expectBool(o: Record<string, unknown>, field: string, arcId: string): boolean {
  const v = o[field]
  if (typeof v !== 'boolean') {
    throw new Error(`Summary for arc ${arcId} missing boolean field '${field}'`)
  }
  return v
}

function expectStringArray(o: Record<string, unknown>, field: string, arcId: string): string[] {
  const v = o[field]
  if (!Array.isArray(v)) {
    throw new Error(`Summary for arc ${arcId} missing array field '${field}'`)
  }
  return v.filter((x): x is string => typeof x === 'string')
}

function expectOutcome(v: unknown, arcId: string): ConversationSummary['outcome'] {
  if (v === 'succeeded' || v === 'failed' || v === 'abandoned' || v === 'partial') return v
  throw new Error(`Summary for arc ${arcId} has invalid outcome: ${String(v)}`)
}

function expectSlotValues(v: unknown, arcId: string): ConversationSummary['slotValues'] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`Summary for arc ${arcId} missing slotValues object`)
  }
  const obj = v as Record<string, unknown>
  const out: Record<string, string[]> = {}
  // Always seed the required keys so consumers can rely on their presence.
  for (const k of ['files', 'tools', 'libraries', 'mcps']) {
    const raw = obj[k]
    out[k] = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  }
  // Preserve any extra slot keys the model surfaced.
  for (const [k, raw] of Object.entries(obj)) {
    if (k in out) continue
    if (Array.isArray(raw)) {
      out[k] = raw.filter((x): x is string => typeof x === 'string')
    }
  }
  return out
}

function expectCorrectionMarkers(v: unknown, arcId: string): ConversationSummary['correctionMarkers'] {
  if (v == null) return []
  if (!Array.isArray(v)) {
    throw new Error(`Summary for arc ${arcId} has non-array correctionMarkers`)
  }
  const out: ConversationSummary['correctionMarkers'] = []
  for (const entry of v) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const quote = typeof e['quote'] === 'string' ? e['quote'] as string : null
    const kind = e['kind']
    if (quote && (kind === 'frustration' || kind === 'reversal')) {
      out.push({ quote, kind })
    }
  }
  return out
}

function expectPersonalizationSignals(
  v: unknown,
  arcId: string,
): ConversationSummary['personalizationSignals'] {
  if (v == null) return []
  if (!Array.isArray(v)) {
    throw new Error(`Summary for arc ${arcId} has non-array personalizationSignals`)
  }
  const out: ConversationSummary['personalizationSignals'] = []
  for (const entry of v) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const kind = typeof e['kind'] === 'string' ? e['kind'] as string : null
    const evidence = typeof e['evidence'] === 'string' ? e['evidence'] as string : null
    if (kind && evidence) out.push({ kind, evidence })
  }
  return out
}

// Test seam — expose validators so tests can probe edge cases directly.
export const __test = {
  expectOutcome,
  expectSlotValues,
  expectCorrectionMarkers,
  expectPersonalizationSignals,
}

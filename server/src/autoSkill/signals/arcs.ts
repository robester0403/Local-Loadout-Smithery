// Phase 0 of the signal-detection pipeline (LOC-69): split a conversation
// into sub-goal arcs so downstream summarization doesn't average across
// distinct intents.
//
// Two-stage detection:
//   1. Cheap heuristics (topic-shift phrases, time gap, cwd shift, resolution
//      followed by new ask).
//   2. LLM-assisted segmentation ONLY when heuristics produce 0 boundaries on
//      a long conversation (>40 turns). The LLM call is injectable so tests
//      can run hermetically.
//
// Output: always at least one arc per conversation. Arcs are turn-index
// ranges over `conversation.messages` (start inclusive, end inclusive).

import { generate } from '../../ollama/client'
import type { ConversationMessage, ConversationRecord } from '../../extractors/types'
import type { SubGoalArc } from './types'

// ---- Tunables ---------------------------------------------------------------

const TIME_GAP_MS = 30 * 60 * 1000 // 30 minutes
const LONG_CONVO_THRESHOLD = 40
const CWD_SHIFT_RUN_LENGTH = 2 // require N consecutive turns in the new cwd
const LLM_DEFAULT_MODEL = 'qwen2.5:3b'

// Lowercased, word-boundary regex match against user message content.
const TOPIC_SHIFT_PHRASES: RegExp[] = [
  /\bok(ay)?,? let'?s try something else\b/i,
  /\bswitch(ing)? gears\b/i,
  /\bnow help me with\b/i,
  /\bdifferent topic\b/i,
  /\bmoving on\b/i,
  /\bnext thing\b/i,
  /\bby the way\b/i,
  /\bactually,? let'?s\b/i,
  /\bnew question\b/i,
  /\bunrelated\b/i,
]

// Acceptance/thanks that, when followed by a fresh question, signals
// resolution → new arc.
const RESOLUTION_PHRASES: RegExp[] = [
  /\bthanks?\b/i,
  /\bthank you\b/i,
  /\bperfect\b/i,
  /\bgreat\b/i,
  /\bnice\b/i,
  /\bworks?\b/i,
  /\bgot it\b/i,
]

// Heuristic that "this user message asks a new thing." Cheap: trailing "?",
// or a question word at the start.
const QUESTION_OPENERS = /^(how|what|why|when|where|can|could|should|would|do|does|is|are|will)\b/i

// ---- Public API -------------------------------------------------------------

export type LlmBoundaryFn = (
  userMessages: Array<{ index: number; content: string }>,
  model: string,
) => Promise<number[]>

export interface SegmentOptions {
  /** Override the LLM boundary call. Required for tests; falls back to a real
   *  Ollama call against `llmModel` if omitted. */
  llmBoundaryFn?: LlmBoundaryFn
  /** Embedding/generation model used by the LLM stage. */
  llmModel?: string
}

export async function segmentIntoArcs(
  conversation: ConversationRecord,
  opts: SegmentOptions = {},
): Promise<SubGoalArc[]> {
  const msgs = conversation.messages
  if (msgs.length === 0) return []

  const heuristic = detectHeuristicBoundaries(msgs, conversation.projectPath)

  let boundaries: number[] = heuristic.boundaries
  let triggers: Map<number, SubGoalArc['triggerSignal']> = heuristic.triggers

  // LLM stage: only fires when heuristics found nothing on a long conversation.
  if (boundaries.length === 0 && msgs.length > LONG_CONVO_THRESHOLD) {
    const fn = opts.llmBoundaryFn ?? defaultLlmBoundaryFn
    const model = opts.llmModel ?? LLM_DEFAULT_MODEL
    try {
      const llmBoundaries = await fn(collectUserMessages(msgs), model)
      const cleaned = sanitizeLlmBoundaries(llmBoundaries, msgs.length)
      if (cleaned.length > 0) {
        boundaries = cleaned
        for (const b of cleaned) triggers.set(b, 'llm-detected')
      }
    } catch {
      // LLM failure → graceful fallback to heuristic-only result (which is
      // "single arc covering the whole conversation").
    }
  }

  return materializeArcs(conversation, boundaries, triggers)
}

// ---- Heuristic stage --------------------------------------------------------

interface HeuristicResult {
  /** Turn indices that should START a new arc (excluding index 0). */
  boundaries: number[]
  triggers: Map<number, SubGoalArc['triggerSignal']>
}

export function detectHeuristicBoundaries(
  msgs: ConversationMessage[],
  fallbackCwd: string,
): HeuristicResult {
  const boundaries = new Set<number>()
  const triggers = new Map<number, SubGoalArc['triggerSignal']>()

  const record = (i: number, t: SubGoalArc['triggerSignal']): void => {
    if (i <= 0 || i >= msgs.length) return
    if (!boundaries.has(i)) {
      boundaries.add(i)
      triggers.set(i, t)
    }
  }

  // cwd-run tracking: only mark a boundary once we've seen `CWD_SHIFT_RUN_LENGTH`
  // consecutive turns in a new directory — otherwise a single transient tool
  // call into a sibling repo would split the arc.
  let currentCwd = msgs[0].cwd || fallbackCwd
  let runStart = 0
  let runCwd = currentCwd

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]

    // Time gap (skip first message; needs a predecessor).
    if (i > 0) {
      const prev = msgs[i - 1]
      const t0 = prev.timestamp ? Date.parse(prev.timestamp) : NaN
      const t1 = m.timestamp ? Date.parse(m.timestamp) : NaN
      if (Number.isFinite(t0) && Number.isFinite(t1) && t1 - t0 >= TIME_GAP_MS) {
        record(i, 'time-gap')
      }
    }

    // Topic-shift phrases — user messages only.
    if (m.role === 'user' && matchesAny(m.content, TOPIC_SHIFT_PHRASES)) {
      record(i, 'topic-shift-phrase')
    }

    // Resolution-then-new-ask: a user thanks at i-1, followed by a question
    // at i. Look back one user message.
    if (m.role === 'user' && QUESTION_OPENERS.test(m.content.trim())) {
      const prevUser = findPrevUser(msgs, i)
      if (prevUser >= 0 && matchesAny(msgs[prevUser].content, RESOLUTION_PHRASES)) {
        record(i, 'topic-shift-phrase')
      }
    }

    // cwd shift: track runs and record a boundary at runStart when the run
    // matures into a new directory.
    const cwdHere = m.cwd || fallbackCwd
    if (cwdHere !== runCwd) {
      // run broke; start a new candidate run
      runCwd = cwdHere
      runStart = i
    }
    if (cwdHere !== currentCwd && i - runStart + 1 >= CWD_SHIFT_RUN_LENGTH) {
      record(runStart, 'tool-shift')
      currentCwd = cwdHere
    }
  }

  const sorted = [...boundaries].sort((a, b) => a - b)
  return { boundaries: sorted, triggers }
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  for (const p of patterns) if (p.test(text)) return true
  return false
}

function findPrevUser(msgs: ConversationMessage[], i: number): number {
  for (let j = i - 1; j >= 0; j--) {
    if (msgs[j].role === 'user') return j
  }
  return -1
}

// ---- LLM stage --------------------------------------------------------------

function collectUserMessages(msgs: ConversationMessage[]): Array<{ index: number; content: string }> {
  const out: Array<{ index: number; content: string }> = []
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== 'user') continue
    // Trim very long messages so the prompt stays cheap.
    const c = msgs[i].content.slice(0, 500)
    out.push({ index: i, content: c })
  }
  return out
}

/** Defensive: drop out-of-range indices, dedup, sort, exclude 0. */
function sanitizeLlmBoundaries(raw: number[], totalTurns: number): number[] {
  const set = new Set<number>()
  for (const n of raw) {
    if (!Number.isInteger(n)) continue
    if (n <= 0 || n >= totalTurns) continue
    set.add(n)
  }
  return [...set].sort((a, b) => a - b)
}

const defaultLlmBoundaryFn: LlmBoundaryFn = async (userMessages, model) => {
  const prompt = buildLlmPrompt(userMessages)
  const raw = await generate({ model, prompt, json: true, timeoutMs: 60_000 })
  const parsed = JSON.parse(raw) as { boundaries?: unknown }
  if (!Array.isArray(parsed.boundaries)) return []
  return parsed.boundaries.filter((n): n is number => typeof n === 'number')
}

function buildLlmPrompt(userMessages: Array<{ index: number; content: string }>): string {
  const lines = userMessages.map(u => `[${u.index}] ${u.content}`).join('\n')
  return [
    'You are segmenting a developer\'s chat session into sub-goal arcs.',
    'Each user message below is prefixed with its turn index in [brackets].',
    'Return JSON of the form {"boundaries": [int, ...]} listing the turn indices',
    'where a NEW sub-goal begins (i.e., a topic shift away from the prior arc).',
    'If the entire session is one cohesive sub-goal, return {"boundaries": []}.',
    'Do not include index 0 — the first message always starts the first arc.',
    '',
    'User messages:',
    lines,
  ].join('\n')
}

// ---- Materialize ------------------------------------------------------------

function materializeArcs(
  conversation: ConversationRecord,
  boundaries: number[],
  triggers: Map<number, SubGoalArc['triggerSignal']>,
): SubGoalArc[] {
  const msgs = conversation.messages
  const starts = [0, ...boundaries]
  const arcs: SubGoalArc[] = []
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]
    const end = i + 1 < starts.length ? starts[i + 1] - 1 : msgs.length - 1
    arcs.push({
      conversationId: conversation.id,
      arcId: `${conversation.id}#${i}`,
      startTurnIndex: start,
      endTurnIndex: end,
      triggerSignal: i === 0 ? 'conversation-start' : triggers.get(start) ?? 'topic-shift-phrase',
    })
  }
  return arcs
}

// Test seam — internals exposed so unit tests can exercise the heuristic
// pipeline without round-tripping through `segmentIntoArcs`.
export const __test = {
  detectHeuristicBoundaries,
  sanitizeLlmBoundaries,
  buildLlmPrompt,
  collectUserMessages,
}

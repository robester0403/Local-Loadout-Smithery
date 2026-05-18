import { generate, isAvailable } from '../ollama/client'
import type { Skill } from '../scanner/types'
import type { ConversationRecord } from '../extractors/types'
import type { Candidate } from './types'

// Body-synthesis pass. Discovery already produced a name + description + score
// per candidate; this pass writes a real body using a (typically) bigger
// model. Output shape depends on the candidate type — commands want a
// concrete prompt template, skills want guidance prose, subagents want a
// fuller spec.

function typeGuidance(t: Candidate['suggestedType']): string {
  switch (t) {
    case 'command':
      return `This is a COMMAND. The body should be a prompt template the user can invoke as /<name>. Write the prompt the way the user would issue it (or paste it into the slash-command), with explicit instructions, placeholders in {curly_braces} for variables, and concrete examples. Keep it self-contained.`
    case 'subagent':
      return `This is a SUBAGENT. The body should be the agent's system prompt + scope. Include: when to invoke this agent, what input it expects, what output it produces, what tools it should use, edge cases to handle. Subagents own their own context — write guidance assuming the agent has fresh state.`
    case 'skill':
    default:
      return `This is a SKILL. The body should be guidance the model loads when the description matches. Include: clear "when to use" cues, concrete steps or rules, examples, and common pitfalls. Skills run inline in the user's session — assume shared context with the main thread.`
  }
}

// Per-conversation budget for the source-signal block. With up to 6 source
// conversations, this keeps the total transcript material under ~24 KB —
// well within an 8K-token (~32 KB) context after the rest of the prompt.
const CHARS_PER_CONVERSATION = 4000

// Render a single conversation as a transcript block. Sampled to stay under
// CHARS_PER_CONVERSATION: head + tail when too long, with a "[…]" marker
// indicating elision. That preserves the opening problem statement and the
// final resolution, which are usually the most signal-dense parts.
function renderConversation(c: ConversationRecord, i: number): string {
  const lines: string[] = [
    `=== Source conversation ${i + 1} [${c.source}] — ${c.startedAt || 'unknown date'} ===`,
  ]
  const turnLines = c.messages.map(m => {
    const role = m.role.toUpperCase()
    const text = m.content.length > 1500 ? m.content.slice(0, 1500) + '…' : m.content
    return `${role}: ${text}`
  })
  const joined = turnLines.join('\n\n')
  if (joined.length <= CHARS_PER_CONVERSATION) {
    lines.push(joined)
  } else {
    const half = Math.floor(CHARS_PER_CONVERSATION / 2)
    lines.push(joined.slice(0, half) + '\n\n[…elided…]\n\n' + joined.slice(-half))
  }
  return lines.join('\n')
}

function buildPrompt(opts: {
  candidate: Candidate
  existing?: Skill
  conversations?: ConversationRecord[]
}): string {
  const { candidate, existing, conversations } = opts

  // Prefer freshly re-extracted conversations when available. Fall back to
  // the candidate's stored excerpts when re-extraction failed (source files
  // moved/deleted, etc.) so synth always produces *something*.
  let sourceBlock: string
  if (conversations && conversations.length > 0) {
    sourceBlock = conversations.slice(0, 6).map(renderConversation).join('\n\n')
  } else {
    sourceBlock = candidate.sourceRefs.slice(0, 8).map((r, i) =>
      `${i + 1}. [${r.source}] ${r.excerpt}`,
    ).join('\n') || '(no excerpts captured)'
  }

  const existingBlock = existing
    ? `

The user already has a similar skill in their loadout. Use its body as a STARTING POINT — the new body should be a clear improvement over it (cover more cases, sharper rules, better examples), not a rewrite.

=== Existing skill: ${existing.name} ===
Description: ${existing.description || '(none)'}

Body:
${(existing.body || '(empty)').slice(0, 6000)}`
    : ''

  return `You are writing the BODY of a Claude/Cursor skill, command, or subagent.

${typeGuidance(candidate.suggestedType)}

=== Candidate metadata ===
Name: ${candidate.name}
Type: ${candidate.suggestedType}
Description (when to use): ${candidate.description}

=== Source signal ===
${conversations && conversations.length > 0
  ? `Excerpts from the actual conversations that motivated this candidate. Ground the body in what the user was ACTUALLY doing — quote and lift concrete commands, file paths, and step sequences from these transcripts. Do not invent details that aren't supported by this material.`
  : `Patterns observed across the user's recent ${candidate.sourceRefs.length} conversation(s):`}

${sourceBlock}
${existingBlock}

Write the body in Markdown. No frontmatter — the Auto Skill adds that on accept. No commentary, no "Here is..." preamble. Return the body content directly.

Style:
- Direct, declarative. The model reading this should immediately know what to do.
- Concrete examples beat abstract description. Reuse specifics from the source conversations when possible.
- If you're writing a command body, the entire output should be the prompt template (or the slash invocation and its parameters).
- 200-1200 words. Longer if the task genuinely needs it.

Begin the body now.`
}

function stripPreamble(raw: string): string {
  let s = raw.trim()
  // Strip ```markdown or ``` code fences if the model wrapped its output.
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:markdown|md)?\n?/i, '').replace(/```\s*$/i, '').trim()
  }
  // Strip "Here is..." / "Sure!" preambles before the real body starts.
  s = s.replace(/^(?:sure[!,.]?|here(?:'s| is)[^\n]*\n+)/i, '')
  return s.trim()
}

export async function synthesizeBody(opts: {
  candidate: Candidate
  existing?: Skill
  /** Freshly re-extracted source conversations. When omitted or empty, synth
   *  falls back to the candidate's stored excerpts. */
  conversations?: ConversationRecord[]
  model: string
  timeoutMs?: number
}): Promise<{ body: string; model: string; sourceMode: 'fresh' | 'excerpts' }> {
  if (!(await isAvailable())) throw new Error('Ollama is not reachable on http://localhost:11434')
  const usedFresh = !!(opts.conversations && opts.conversations.length > 0)
  const raw = await generate({
    model: opts.model,
    prompt: buildPrompt({ candidate: opts.candidate, existing: opts.existing, conversations: opts.conversations }),
    // Body generation is creative — give it slightly more room than the
    // structured-extraction default.
    temperature: 0.4,
    timeoutMs: opts.timeoutMs ?? 3 * 60_000,
  })
  return { body: stripPreamble(raw), model: opts.model, sourceMode: usedFresh ? 'fresh' : 'excerpts' }
}

export const __test = { buildPrompt, stripPreamble, renderConversation }

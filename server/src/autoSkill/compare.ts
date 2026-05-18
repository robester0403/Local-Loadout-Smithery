import { generate, isAvailable } from '../ollama/client'
import type { Skill } from '../scanner/types'
import type { Candidate, ImprovementKind, ImprovementNotes, ImprovementSuggestion } from './types'

const SYSTEM_PROMPT = `You compare an existing Claude/Cursor skill against a proposed new candidate that the Auto Skill thinks may duplicate it. Identify concrete improvements the candidate offers over the existing skill — additions to its description ("when to use") or body (guidance/prompt), not stylistic rewrites.

Return STRICT JSON with this shape — no prose, no markdown fences:
{
  "suggestions": [
    { "kind": "add-to-description" | "add-to-body" | "no-improvement", "text": "Concrete, actionable sentence." }
  ]
}

Rules:
- If the candidate is essentially identical / weaker, return a single { kind: "no-improvement", text: "Reason in one sentence." }.
- Otherwise list 1-5 specific things to ADD to the existing skill. Quote phrases when useful.
- Each suggestion should be self-contained and immediately actionable by someone editing the existing skill file.
- Do not propose deleting from or rewriting the existing skill — only additions / clarifications.`

function buildPrompt(existing: Skill, candidate: Candidate): string {
  return `${SYSTEM_PROMPT}

=== Existing skill ===
Type: ${existing.type}
Name: ${existing.name}
Description: ${existing.description || '(none)'}

Body:
${(existing.body || '(empty)').slice(0, 8000)}

=== Candidate ===
Type: ${candidate.suggestedType}
Name: ${candidate.name}
Description: ${candidate.description}

Body:
${(candidate.bodyDraft || '(empty)').slice(0, 8000)}

Return JSON only.`
}

function parseResponse(raw: string): ImprovementSuggestion[] {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/i, '').replace(/```\s*$/i, '')
  }
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) return []
  cleaned = cleaned.slice(start, end + 1)
  let parsed: { suggestions?: unknown }
  try { parsed = JSON.parse(cleaned) as { suggestions?: unknown } } catch { return [] }
  if (!Array.isArray(parsed.suggestions)) return []
  const out: ImprovementSuggestion[] = []
  for (const raw of parsed.suggestions) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as { kind?: unknown; text?: unknown }
    if (typeof r.text !== 'string' || !r.text.trim()) continue
    if (r.kind !== 'add-to-description' && r.kind !== 'add-to-body' && r.kind !== 'no-improvement') continue
    out.push({ kind: r.kind as ImprovementKind, text: r.text.trim() })
  }
  return out
}

export async function compareCandidate(opts: {
  candidate: Candidate
  existing: Skill
  model: string
}): Promise<ImprovementNotes> {
  if (!(await isAvailable())) throw new Error('Ollama is not reachable on http://localhost:11434')
  const raw = await generate({
    model: opts.model,
    prompt: buildPrompt(opts.existing, opts.candidate),
    json: true,
    timeoutMs: 90_000,
  })
  const suggestions = parseResponse(raw)
  return {
    suggestions: suggestions.length > 0
      ? suggestions
      : [{ kind: 'no-improvement', text: 'Model returned no parseable suggestions.' }],
    comparedAt: new Date().toISOString(),
    model: opts.model,
    comparedSkillId: opts.existing.id,
  }
}

export const __test = { parseResponse, buildPrompt }

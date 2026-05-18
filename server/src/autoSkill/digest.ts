import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { isAvailable, generate } from '../ollama/client'
import { purgeRawConversations } from '../extractors/store'
import type { ConversationRecord } from '../extractors/types'
import { upsertGenerated } from './store'
import type { Candidate, CandidateSourceRef, CandidateType, DigestResult } from './types'

const CONVERSATIONS_ROOT = path.join(os.homedir(), '.loadoutsmith', 'conversations')

// ─── Loading extracted conversations ─────────────────────────────────────────

function loadAllConversations(): ConversationRecord[] {
  if (!fs.existsSync(CONVERSATIONS_ROOT)) return []
  const out: ConversationRecord[] = []
  for (const source of fs.readdirSync(CONVERSATIONS_ROOT)) {
    if (source.startsWith('.')) continue
    const dir = path.join(CONVERSATIONS_ROOT, source)
    let stat: fs.Stats
    try { stat = fs.statSync(dir) } catch { continue }
    if (!stat.isDirectory()) continue
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8')
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          out.push(JSON.parse(trimmed) as ConversationRecord)
        } catch { /* skip malformed line */ }
      }
    }
  }
  return out
}

// ─── Chunking ────────────────────────────────────────────────────────────────

// Group conversations into chunks small enough to fit in a typical 8k–32k
// context window. We measure roughly: 1 char ≈ 0.25 tokens. Aim ~12k tokens
// per chunk so even a 16k-context model has room for the prompt + response.
const CHARS_PER_CHUNK = 12_000 * 4 // ~48k chars

interface ChunkConversation {
  id: string
  source: ConversationRecord['source']
  startedAt: string
  excerpt: string
  digestText: string
}

function summarizeConversation(c: ConversationRecord): ChunkConversation {
  // Compact representation fed to the model: alternating role lines, content
  // trimmed to keep one conversation from monopolizing a chunk.
  const turns: string[] = []
  for (const m of c.messages) {
    const text = m.content.length > 1500 ? m.content.slice(0, 1500) + '…' : m.content
    turns.push(`${m.role.toUpperCase()}: ${text}`)
  }
  const firstUser = c.messages.find(m => m.role === 'user')?.content ?? ''
  const excerpt = firstUser.replace(/\s+/g, ' ').slice(0, 120)
  return {
    id: c.id,
    source: c.source,
    startedAt: c.startedAt,
    excerpt,
    digestText: turns.join('\n\n'),
  }
}

function chunk(conversations: ChunkConversation[]): ChunkConversation[][] {
  const chunks: ChunkConversation[][] = []
  let cur: ChunkConversation[] = []
  let curChars = 0
  for (const c of conversations) {
    const size = c.digestText.length
    if (size > CHARS_PER_CHUNK) {
      // Pathologically long single conversation — push as its own chunk and
      // let the model deal with whatever fits.
      if (cur.length > 0) { chunks.push(cur); cur = []; curChars = 0 }
      chunks.push([c])
      continue
    }
    if (curChars + size > CHARS_PER_CHUNK && cur.length > 0) {
      chunks.push(cur)
      cur = []
      curChars = 0
    }
    cur.push(c)
    curChars += size
  }
  if (cur.length > 0) chunks.push(cur)
  return chunks
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You analyze a user's recent AI chat conversations and identify patterns worth turning into reusable Claude/Cursor "skills", "commands", or "subagents".

Definitions:
- "skill": a discrete capability with a description ("when to use"), a body of guidance, and frontmatter. Use when the user keeps asking for the same kind of task and would benefit from a stable description.
- "command": a slash-invocable prompt template the user can run on demand. Use when the user issues the same kind of request repeatedly and a fixed prompt would short-circuit it.
- "subagent": a delegated specialist with its own context and tools. Use when the work is heavy enough that the user would benefit from a child agent rather than inline guidance.

Return STRICT JSON with this shape — no prose, no markdown fences:
{
  "candidates": [
    {
      "name": "short-kebab-case-name",
      "type": "skill" | "command" | "subagent",
      "description": "One sentence: WHEN to use this. Start with 'Use when...' or 'When...'.",
      "body": "The instructional body. For commands: the prompt template itself. For skills/subagents: the guidance the model needs to perform the task well. Markdown allowed.",
      "evidence": ["conversationId1", "conversationId2"]
    }
  ]
}

Rules:
- Only propose candidates supported by ≥2 conversations or one strikingly clear repeated pattern.
- Skip one-offs, generic Q&A, and exploratory chat with no reusable artifact.
- Prefer fewer high-quality candidates over many weak ones. 0–6 per chunk is normal.
- The "evidence" array MUST reference conversation IDs you saw in this batch.`

function buildPrompt(batch: ChunkConversation[]): string {
  const blocks = batch.map((c, i) => `=== Conversation ${i + 1} ===
id: ${c.id}
source: ${c.source}
started: ${c.startedAt}

${c.digestText}`)
  return `${SYSTEM_PROMPT}

Here are ${batch.length} conversations to analyze:

${blocks.join('\n\n')}

Return JSON only.`
}

// ─── Parsing & scoring ──────────────────────────────────────────────────────

interface LLMCandidate {
  name?: unknown
  type?: unknown
  description?: unknown
  body?: unknown
  evidence?: unknown
}

function parseLLMResponse(raw: string, warnings: string[]): LLMCandidate[] {
  // Models sometimes wrap the JSON in ```json fences despite the prompt.
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/i, '').replace(/```\s*$/i, '')
  }
  // Find the first { and last } — model occasionally adds preamble.
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) {
    warnings.push('Model response had no JSON object')
    return []
  }
  cleaned = cleaned.slice(start, end + 1)
  try {
    const parsed = JSON.parse(cleaned) as { candidates?: unknown }
    if (!Array.isArray(parsed.candidates)) return []
    return parsed.candidates as LLMCandidate[]
  } catch (e) {
    warnings.push(`JSON parse failed: ${(e as Error).message}`)
    return []
  }
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'candidate'
}

function signatureOf(type: CandidateType, name: string): string {
  return crypto.createHash('sha1').update(`${type}::${slugify(name)}`).digest('hex').slice(0, 16)
}

function recencyWeight(refs: CandidateSourceRef[]): number {
  // 0–1, weighted toward more recent refs. Anything older than 30 days contributes 0.
  const now = Date.now()
  const window = 30 * 24 * 60 * 60 * 1000
  let total = 0
  for (const r of refs) {
    const t = Date.parse(r.at)
    if (!Number.isFinite(t)) continue
    const age = now - t
    if (age < 0) continue
    const w = Math.max(0, 1 - age / window)
    total += w
  }
  return Math.min(1, total / Math.max(1, refs.length))
}

function scoreOf(refs: CandidateSourceRef[]): number {
  // Frequency × recency, capped at 1.
  const freqWeight = Math.min(1, refs.length / 5)
  return Number((freqWeight * 0.6 + recencyWeight(refs) * 0.4).toFixed(3))
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

export interface DigestOptions {
  model: string
  /** Only conversations newer than this ISO date are processed. Defaults to
   *  14 days ago to mirror extractor defaults. */
  sinceIso?: string
  /** If true, purge raw conversation JSONL after a successful run. */
  purgeRawOnSuccess?: boolean
}

export async function runDigest(opts: DigestOptions): Promise<DigestResult> {
  const start = Date.now()
  const warnings: string[] = []
  const sinceMs = opts.sinceIso ? Date.parse(opts.sinceIso) : Date.now() - 14 * 24 * 60 * 60 * 1000

  if (!opts.model) throw new Error('No model selected — set autoSkill.model in settings.')
  if (!(await isAvailable())) throw new Error('Ollama is not reachable on http://localhost:11434')

  const all = loadAllConversations()
  const filtered = all.filter(c => {
    const t = Date.parse(c.startedAt || c.endedAt || '')
    return Number.isFinite(t) ? t >= sinceMs : true
  })

  const conversationsById = new Map(filtered.map(c => [c.id, c]))
  const summarized = filtered.map(summarizeConversation)
  const chunks = chunk(summarized)

  let created = 0
  let updated = 0

  for (const batch of chunks) {
    let raw: string
    try {
      raw = await generate({ model: opts.model, prompt: buildPrompt(batch), json: true })
    } catch (e) {
      warnings.push(`Chunk failed: ${(e as Error).message}`)
      continue
    }
    const items = parseLLMResponse(raw, warnings)
    for (const item of items) {
      if (typeof item.name !== 'string' || typeof item.description !== 'string') continue
      if (item.type !== 'skill' && item.type !== 'command' && item.type !== 'subagent') continue
      const evidenceIds = Array.isArray(item.evidence)
        ? item.evidence.filter((x): x is string => typeof x === 'string')
        : []

      // Tie evidence back to known conversations (drop hallucinated ids).
      const refs: CandidateSourceRef[] = []
      for (const cid of evidenceIds) {
        const c = conversationsById.get(cid)
        if (!c) continue
        refs.push({
          source: c.source,
          conversationId: c.id,
          excerpt: summarizeConversation(c).excerpt,
          at: c.startedAt || c.endedAt || '',
        })
      }
      if (refs.length === 0) {
        // Fallback: attribute to all conversations in the batch. Better than
        // dropping the candidate entirely, and the user can still see which
        // window produced it.
        for (const b of batch) {
          refs.push({ source: b.source, conversationId: b.id, excerpt: b.excerpt, at: b.startedAt })
        }
      }

      const name = item.name
      const type = item.type as CandidateType
      const body = typeof item.body === 'string' ? item.body : ''
      const result = upsertGenerated({
        signature: signatureOf(type, name),
        name,
        description: item.description,
        bodyDraft: body,
        suggestedType: type,
        score: scoreOf(refs),
        sourceRefs: refs,
        model: opts.model,
      } as Omit<Candidate, 'id' | 'status' | 'createdAt' | 'updatedAt'>)
      if (result.created) created += 1
      else updated += 1
    }
  }

  if (opts.purgeRawOnSuccess) {
    try {
      purgeRawConversations()
    } catch (e) {
      warnings.push(`Failed to purge raw conversations: ${(e as Error).message}`)
    }
  }

  return {
    candidatesCreated: created,
    candidatesUpdated: updated,
    conversationsProcessed: filtered.length,
    chunksProcessed: chunks.length,
    warnings,
    durationMs: Date.now() - start,
    model: opts.model,
  }
}

export const __test = { chunk, summarizeConversation, parseLLMResponse, signatureOf, scoreOf, slugify }

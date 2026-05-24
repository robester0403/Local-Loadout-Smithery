// Thin wrapper over the local Ollama daemon (http://localhost:11434). All
// methods are isolated network calls — no global state. The Auto Skill panel checks
// `isAvailable()` first and surfaces an install CTA when false.

const DEFAULT_HOST = 'http://localhost:11434'

function host(): string {
  return process.env['OLLAMA_HOST'] ?? DEFAULT_HOST
}

export interface OllamaModel {
  name: string
  /** Bytes. Useful for sorting by approximate "size" in the picker. */
  size: number
  modified_at: string
}

export async function isAvailable(timeoutMs = 1500): Promise<boolean> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${host()}/api/tags`, { signal: ctrl.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

// The single model name we've most recently called generate() with this
// process. Used to keep at most ONE model in RAM at a time: before any
// generate() that targets a different model, we proactively drop the
// previous one so the user never pays for two large weights side-by-side.
let activeModel: string | null = null

async function dropModel(name: string, timeoutMs: number): Promise<void> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    // POST /api/generate with keep_alive: 0 evicts immediately. Empty
    // prompt is fine; Ollama just needs the keep_alive signal.
    await fetch(`${host()}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, prompt: '', keep_alive: 0, stream: false }),
      signal: ctrl.signal,
    }).catch(() => undefined)
  } finally {
    clearTimeout(t)
  }
}

// Drop the model this process loaded (if any). Called from the app's
// shutdown handler so Ctrl+C frees the model's RAM immediately instead of
// waiting out Ollama's ~5 min keep_alive. Best-effort, capped timeout.
export async function unloadActiveModel(timeoutMs = 2000): Promise<string | null> {
  const name = activeModel
  if (!name) return null
  activeModel = null
  await dropModel(name, timeoutMs)
  return name
}

export async function listModels(): Promise<OllamaModel[]> {
  const res = await fetch(`${host()}/api/tags`)
  if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`)
  const body = await res.json() as { models?: OllamaModel[] }
  return body.models ?? []
}

// Non-streaming generate — collects the whole response then returns. For the
// candidate-generator workload (one JSON blob per chunk) this is the natural
// shape; streaming is overkill.
export async function generate(opts: {
  model: string
  prompt: string
  /** Pass true to ask Ollama for JSON-formatted output (uses its `format`
   *  option, which most modern models respect well enough for our use). */
  json?: boolean
  /** Temperature override. Defaults to 0.2 — we want determinism for
   *  structured extraction, not creativity. */
  temperature?: number
  /** Hard timeout in ms. Defaults to 5 minutes — large lookbacks on a small
   *  model can be slow. */
  timeoutMs?: number
}): Promise<string> {
  // Single-model-at-a-time policy: if we've already loaded a different
  // model this session, drop it before requesting the new one. Capped at
  // 3s so a stuck unload doesn't block the real work.
  if (activeModel && activeModel !== opts.model) {
    await dropModel(activeModel, 3000)
  }
  // Mark active BEFORE the request, since Ollama starts loading the model
  // the moment it receives the POST — even a later request failure leaves
  // weights resident.
  activeModel = opts.model

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5 * 60_000)
  try {
    const res = await fetch(`${host()}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        prompt: opts.prompt,
        stream: false,
        ...(opts.json ? { format: 'json' } : {}),
        options: { temperature: opts.temperature ?? 0.2 },
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Ollama /api/generate returned ${res.status}: ${text.slice(0, 200)}`)
    }
    const body = await res.json() as { response?: string }
    return body.response ?? ''
  } finally {
    clearTimeout(t)
  }
}

// Embeddings for the signal-detection pipeline (LOC-69 Phase 2 clustering).
// Returns the raw vector from Ollama's /api/embeddings — callers handle the
// math (cosine similarity, k-means, etc.). Unlike generate(), embedding models
// are tiny and cheap to keep resident, so this does NOT participate in the
// single-active-model eviction dance.
export async function embeddings(opts: {
  /** Embedding model. Default 'nomic-embed-text'. */
  model?: string
  prompt: string
  timeoutMs?: number
}): Promise<number[]> {
  const model = opts.model ?? 'nomic-embed-text'
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000)
  try {
    const res = await fetch(`${host()}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: opts.prompt }),
      signal: ctrl.signal,
    })
    if (res.status === 404) {
      // Ollama returns 404 with a body like {"error":"model 'x' not found, try pulling it first"}.
      throw new Error(
        `Embedding model '${model}' is not pulled. Run \`ollama pull ${model}\` and retry.`,
      )
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Ollama /api/embeddings returned ${res.status}: ${text.slice(0, 200)}`)
    }
    const body = await res.json() as { embedding?: number[] }
    if (!Array.isArray(body.embedding) || body.embedding.length === 0) {
      throw new Error(`Ollama /api/embeddings returned no embedding for model '${model}'`)
    }
    return body.embedding
  } finally {
    clearTimeout(t)
  }
}

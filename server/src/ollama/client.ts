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

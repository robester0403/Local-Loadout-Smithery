// In-memory embedding cache for one digest run. Wraps the Ollama embeddings
// call so the clusterer (LOC-73) doesn't pay for redundant /api/embeddings
// hits on identical input strings (common when intent + slot strings repeat
// across arcs).
//
// No disk persistence in v1 — a digest run is bounded and the cache only
// needs to survive the run. The cluster module clears the cache at the
// start of each `clusterSummaries` call.

import crypto from 'crypto'
import { embeddings } from '../../ollama/client'

const DEFAULT_EMBED_MODEL = 'nomic-embed-text'

const cache = new Map<string, number[]>()

export interface EmbedOptions {
  model?: string
  timeoutMs?: number
}

export async function embedText(text: string, opts: EmbedOptions = {}): Promise<number[]> {
  const model = opts.model ?? DEFAULT_EMBED_MODEL
  const key = `${model}:${sha256(text)}`
  const hit = cache.get(key)
  if (hit) return hit
  const v = await embeddings({ model, prompt: text, timeoutMs: opts.timeoutMs })
  cache.set(key, v)
  return v
}

export function clearEmbedCache(): void {
  cache.clear()
}

/** For diagnostics + tests. */
export function embedCacheSize(): number {
  return cache.size
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}

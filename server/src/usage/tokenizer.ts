import { getTokenizer } from '@anthropic-ai/tokenizer'
import type { Tiktoken } from 'tiktoken/lite'

// Constructing Tiktoken from the 696KB BPE vocab costs ~22ms per call.
// The default @anthropic-ai/tokenizer behaviour creates a new instance on every
// countTokens() call — 200+ calls during skill discovery = 4+ seconds of sync CPU.
// Cache the instance for the process lifetime instead.
let enc: Tiktoken | null = null

function getCachedTokenizer(): Tiktoken {
  if (!enc) enc = getTokenizer()
  return enc
}

export function countTokens(text: string): number {
  if (!text) return 0
  return getCachedTokenizer().encode(text.normalize('NFKC'), 'all').length
}

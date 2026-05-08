import { countTokens as anthropicCountTokens } from '@anthropic-ai/tokenizer'

export function countTokens(text: string): number {
  if (!text) return 0
  return anthropicCountTokens(text)
}

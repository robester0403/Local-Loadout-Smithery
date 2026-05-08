import { describe, it, expect } from 'vitest'
import { countTokens } from '../usage/tokenizer'

describe('countTokens', () => {
  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0)
  })

  it('counts tokens for known text', () => {
    // "hello world" → 2 BPE tokens with the Claude vocab
    expect(countTokens('hello world')).toBe(2)
  })

  it('counts a longer sentence', () => {
    // "the quick brown fox jumps over the lazy dog" → 9 tokens
    expect(countTokens('the quick brown fox jumps over the lazy dog')).toBe(9)
  })

  it('handles punctuation and numbers', () => {
    const n = countTokens('Hello, world! 123')
    expect(n).toBeGreaterThan(0)
    expect(Number.isInteger(n)).toBe(true)
  })

  it('returns a stable count across repeated calls', () => {
    const a = countTokens('stability check')
    const b = countTokens('stability check')
    expect(a).toBe(b)
  })

  it('different texts give different counts', () => {
    const short = countTokens('hi')
    const long = countTokens('this is a much longer piece of text with many more words in it')
    expect(long).toBeGreaterThan(short)
  })
})

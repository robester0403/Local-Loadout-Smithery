import { describe, it, expect } from 'vitest'
import { levenshtein, normalizedLevenshtein } from '../autoSkill/signals/lib/levenshtein'

describe('levenshtein', () => {
  it('identical strings = 0', () => {
    expect(levenshtein('hello', 'hello')).toBe(0)
  })

  it('empty + non-empty = length of non-empty', () => {
    expect(levenshtein('', 'abcd')).toBe(4)
    expect(levenshtein('abcd', '')).toBe(4)
  })

  it('classic distance examples', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('flaw', 'lawn')).toBe(2)
    expect(levenshtein('book', 'back')).toBe(2)
  })

  it('handles unicode codepoints by char (BMP only)', () => {
    expect(levenshtein('café', 'cafe')).toBe(1)
  })
})

describe('normalizedLevenshtein', () => {
  it('returns 0 for identical, 1 for fully disjoint same-length', () => {
    expect(normalizedLevenshtein('abcd', 'abcd')).toBe(0)
    expect(normalizedLevenshtein('abcd', 'wxyz')).toBe(1)
  })

  it('returns 0 for two empty strings', () => {
    expect(normalizedLevenshtein('', '')).toBe(0)
  })

  it('returns the right ratio for partial overlap', () => {
    // "kitten" vs "sitting": distance 3, max length 7 → 3/7 ≈ 0.43
    expect(normalizedLevenshtein('kitten', 'sitting')).toBeCloseTo(3 / 7, 5)
  })
})

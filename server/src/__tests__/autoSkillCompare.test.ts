import { describe, it, expect } from 'vitest'
import { __test } from '../autoSkill/compare'

describe('parseResponse', () => {
  it('parses a clean JSON suggestion list', () => {
    const out = __test.parseResponse(`{"suggestions":[
      {"kind":"add-to-description","text":"Mention edge case X."},
      {"kind":"add-to-body","text":"Add a section on Y."},
      {"kind":"no-improvement","text":"Already covered."}
    ]}`)
    expect(out).toHaveLength(3)
    expect(out[0].kind).toBe('add-to-description')
  })

  it('strips ```json fences', () => {
    const out = __test.parseResponse('```json\n{"suggestions":[{"kind":"add-to-body","text":"x"}]}\n```')
    expect(out).toHaveLength(1)
  })

  it('drops invalid entries (bad kind, missing text)', () => {
    const out = __test.parseResponse(`{"suggestions":[
      {"kind":"bogus","text":"hi"},
      {"text":"missing kind"},
      {"kind":"add-to-body"},
      {"kind":"add-to-body","text":"good one"}
    ]}`)
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('good one')
  })

  it('returns empty list on broken JSON', () => {
    expect(__test.parseResponse('{not json')).toEqual([])
  })
})

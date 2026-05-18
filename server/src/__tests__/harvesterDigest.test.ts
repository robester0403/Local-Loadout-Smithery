import { describe, it, expect } from 'vitest'
import { __test } from '../harvester/digest'

describe('parseLLMResponse', () => {
  it('parses a clean JSON response', () => {
    const warnings: string[] = []
    const out = __test.parseLLMResponse(
      '{"candidates":[{"name":"foo","type":"skill","description":"d","body":"b","evidence":["x"]}]}',
      warnings,
    )
    expect(out).toHaveLength(1)
    expect(warnings).toEqual([])
  })

  it('strips ```json fences', () => {
    const warnings: string[] = []
    const out = __test.parseLLMResponse(
      '```json\n{"candidates":[]}\n```',
      warnings,
    )
    expect(out).toEqual([])
  })

  it('tolerates preamble before the JSON object', () => {
    const warnings: string[] = []
    const out = __test.parseLLMResponse(
      'Here is your JSON:\n{"candidates":[{"name":"x","type":"command","description":"d","body":"","evidence":[]}]}',
      warnings,
    )
    expect(out).toHaveLength(1)
  })

  it('records a warning on broken JSON', () => {
    const warnings: string[] = []
    const out = __test.parseLLMResponse('{not json', warnings)
    expect(out).toEqual([])
    expect(warnings.length).toBeGreaterThan(0)
  })
})

describe('signatureOf', () => {
  it('produces the same signature for type+slugified name regardless of casing/spaces', () => {
    expect(__test.signatureOf('skill', 'Refactor Helper')).toBe(__test.signatureOf('skill', 'refactor-helper'))
    expect(__test.signatureOf('skill', 'refactor helper!!')).toBe(__test.signatureOf('skill', 'refactor-helper'))
  })

  it('differs across types even when the name matches', () => {
    expect(__test.signatureOf('skill', 'x')).not.toBe(__test.signatureOf('command', 'x'))
  })
})

describe('scoreOf', () => {
  it('returns 0 for empty refs', () => {
    expect(__test.scoreOf([])).toBe(0)
  })

  it('caps at 1', () => {
    const now = new Date().toISOString()
    const refs = Array.from({ length: 20 }, (_, i) => ({
      source: 'claude' as const, conversationId: String(i), excerpt: '', at: now,
    }))
    expect(__test.scoreOf(refs)).toBeLessThanOrEqual(1)
  })

  it('weights recent conversations higher than old ones', () => {
    const recent = [{ source: 'claude' as const, conversationId: '1', excerpt: '', at: new Date().toISOString() }]
    const old = [{ source: 'claude' as const, conversationId: '1', excerpt: '', at: '2020-01-01T00:00:00.000Z' }]
    expect(__test.scoreOf(recent)).toBeGreaterThan(__test.scoreOf(old))
  })
})

describe('chunk', () => {
  it('groups conversations under the char cap into a single chunk', () => {
    const conv = Array.from({ length: 3 }, (_, i) => ({
      id: String(i), source: 'claude' as const, startedAt: '', excerpt: '', digestText: 'short text',
    }))
    expect(__test.chunk(conv)).toHaveLength(1)
  })

  it('splits when total chars exceed the cap', () => {
    const big = 'x'.repeat(30_000)
    const conv = Array.from({ length: 4 }, (_, i) => ({
      id: String(i), source: 'claude' as const, startedAt: '', excerpt: '', digestText: big,
    }))
    expect(__test.chunk(conv).length).toBeGreaterThan(1)
  })

  it('isolates pathologically large single conversations', () => {
    const huge = 'x'.repeat(200_000)
    const small = 'x'.repeat(10)
    const conv = [
      { id: 's1', source: 'claude' as const, startedAt: '', excerpt: '', digestText: small },
      { id: 'h', source: 'claude' as const, startedAt: '', excerpt: '', digestText: huge },
      { id: 's2', source: 'claude' as const, startedAt: '', excerpt: '', digestText: small },
    ]
    const chunks = __test.chunk(conv)
    const huguChunk = chunks.find(c => c.length === 1 && c[0].id === 'h')
    expect(huguChunk).toBeDefined()
  })
})

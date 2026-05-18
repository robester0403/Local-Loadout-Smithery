import { describe, it, expect } from 'vitest'
import { __test } from '../autoSkill/synth'
import type { Candidate } from '../autoSkill/types'

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    id: 'c', signature: 's', name: 'foo', description: 'When to use foo.',
    bodyDraft: '', suggestedType: 'skill', score: 0.5, status: 'pending',
    sourceRefs: [
      { source: 'claude', conversationId: '1', excerpt: 'first excerpt', at: '2026-05-01T00:00:00Z' },
      { source: 'cursor', conversationId: '2', excerpt: 'second excerpt', at: '2026-05-02T00:00:00Z' },
    ],
    createdAt: '', updatedAt: '', model: 'qwen2.5:3b',
    ...over,
  }
}

describe('buildPrompt', () => {
  it('includes type-specific guidance and source excerpts', () => {
    const p = __test.buildPrompt({ candidate: candidate() })
    expect(p).toContain('SKILL')
    expect(p).toContain('first excerpt')
    expect(p).toContain('second excerpt')
    expect(p).not.toContain('Existing skill')
  })

  it('switches guidance per type', () => {
    expect(__test.buildPrompt({ candidate: candidate({ suggestedType: 'command' }) })).toContain('COMMAND')
    expect(__test.buildPrompt({ candidate: candidate({ suggestedType: 'subagent' }) })).toContain('SUBAGENT')
  })
})

describe('stripPreamble', () => {
  it('removes ``` fences', () => {
    expect(__test.stripPreamble('```markdown\nHello\n```')).toBe('Hello')
    expect(__test.stripPreamble('```\nHello\n```')).toBe('Hello')
  })

  it('removes "Here is..." preamble', () => {
    expect(__test.stripPreamble("Sure! Here is the body:\n\n# Title")).toContain('# Title')
    expect(__test.stripPreamble("Sure! Here is the body:\n\n# Title").startsWith('Sure')).toBe(false)
  })

  it('leaves clean output alone', () => {
    expect(__test.stripPreamble('# Real body content')).toBe('# Real body content')
  })
})

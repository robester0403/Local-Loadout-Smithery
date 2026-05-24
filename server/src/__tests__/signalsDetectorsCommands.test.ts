import { describe, it, expect } from 'vitest'
import { detectCommands } from '../autoSkill/signals/detectors/commands'
import { __test } from '../autoSkill/signals/detectors/commands'
import type { ConversationSummary } from '../autoSkill/signals/types'

// ---- Fixture helpers --------------------------------------------------------

let nextArc = 0
function summary(
  prompts: string[],
  opts: { conversationId?: string; source?: 'claude' | 'cursor' | 'codex' } = {},
): ConversationSummary {
  const arc = `arc-${nextArc++}`
  return {
    arcId: arc,
    conversationId: opts.conversationId ?? `conv-${arc}`,
    source: opts.source ?? 'claude',
    startedAt: '2026-05-20T12:00:00.000Z',
    intent: '',
    slotValues: { files: [], tools: [], libraries: [], mcps: [] },
    resolutionSteps: [],
    outcome: 'succeeded',
    stableApproach: true,
    subGoals: [],
    toolSignature: [],
    invokedSkills: [],
    verbatimUserPrompts: prompts,
    correctionMarkers: [],
    personalizationSignals: [],
  }
}

const REVIEW_PROMPT =
  'Review this pull request carefully. Check for unused imports, missing tests, regressions in the existing test suite, and any obvious security smells like SQL injection or path traversal. Suggest concrete fixes.'

const SHORT_PROMPT = 'fix bug pls'

// ---- detectCommands ---------------------------------------------------------

describe('detectCommands', () => {
  it('a long prompt typed in 2+ distinct conversations becomes one candidate', () => {
    const s = [
      summary([REVIEW_PROMPT], { conversationId: 'conv-1' }),
      summary([REVIEW_PROMPT], { conversationId: 'conv-2' }),
    ]
    const out = detectCommands(s)
    expect(out).toHaveLength(1)
    expect(out[0].suggestedType).toBe('command')
    expect(out[0].invocationCount).toBe(2)
    expect(out[0].promptText).toBe(REVIEW_PROMPT)
    expect(out[0].suggestedSlug).toMatch(/review/)
    expect(out[0].evidenceQuotes?.length).toBeGreaterThan(0)
  })

  it('counts ALL occurrences (including same-conversation dupes) in invocationCount', () => {
    const s = [
      summary([REVIEW_PROMPT, REVIEW_PROMPT], { conversationId: 'conv-1' }),
      summary([REVIEW_PROMPT], { conversationId: 'conv-2' }),
    ]
    const out = detectCommands(s)
    expect(out).toHaveLength(1)
    expect(out[0].invocationCount).toBe(3)
    // Distinct conversation refs only (dedup by conversationId).
    expect(out[0].sourceRefs).toHaveLength(2)
  })

  it('drops prompts shorter than minPromptLength', () => {
    const s = [
      summary([SHORT_PROMPT], { conversationId: 'conv-1' }),
      summary([SHORT_PROMPT], { conversationId: 'conv-2' }),
    ]
    expect(detectCommands(s)).toEqual([])
  })

  it('drops mostly-code prompts', () => {
    const codePrompt = '```ts\n' + 'a'.repeat(200) + '\n```\n' + '/some/path/file.ts:1:1'
    const s = [
      summary([codePrompt], { conversationId: 'conv-1' }),
      summary([codePrompt], { conversationId: 'conv-2' }),
    ]
    expect(detectCommands(s)).toEqual([])
  })

  it('merges near-duplicate prompts (Levenshtein < 0.2)', () => {
    const v1 = REVIEW_PROMPT
    const v2 = REVIEW_PROMPT + ' Also flag any TODO comments.'
    const s = [
      summary([v1], { conversationId: 'conv-1' }),
      summary([v2], { conversationId: 'conv-2' }),
      summary([v2], { conversationId: 'conv-3' }),
    ]
    const out = detectCommands(s)
    expect(out).toHaveLength(1)
    // The longest is the canonical text (richer template).
    expect(out[0].promptText).toBe(v2)
    expect(out[0].invocationCount).toBe(3)
  })

  it('drops candidates that near-duplicate an existing command', () => {
    const s = [
      summary([REVIEW_PROMPT], { conversationId: 'conv-1' }),
      summary([REVIEW_PROMPT], { conversationId: 'conv-2' }),
    ]
    const out = detectCommands(s, { existingCommandTexts: [REVIEW_PROMPT] })
    expect(out).toEqual([])
  })

  it('drops prompts that only appear in one conversation', () => {
    const s = [
      summary([REVIEW_PROMPT, REVIEW_PROMPT, REVIEW_PROMPT], { conversationId: 'conv-1' }),
    ]
    expect(detectCommands(s)).toEqual([])
  })

  it('makes zero LLM calls (pure heuristic)', () => {
    // No injection point exists for an LLM in this detector. Verify by
    // running a non-trivial fixture and ensuring no async wait beyond the
    // synchronous return. The function is synchronous by signature; if a
    // future change adds LLM calls it'd need to become async and this
    // assertion would force the test to fail-compile.
    const s = [
      summary([REVIEW_PROMPT], { conversationId: 'conv-1' }),
      summary([REVIEW_PROMPT], { conversationId: 'conv-2' }),
    ]
    const out = detectCommands(s)
    expect(Array.isArray(out)).toBe(true)
  })

  it('signature uses (type + slug) so re-runs are idempotent', () => {
    const s = [
      summary([REVIEW_PROMPT], { conversationId: 'conv-1' }),
      summary([REVIEW_PROMPT], { conversationId: 'conv-2' }),
    ]
    const a = detectCommands(s)[0].signature
    const b = detectCommands(s)[0].signature
    expect(a).toBe(b)
  })
})

// ---- helpers ----------------------------------------------------------------

describe('helpers', () => {
  it('codeRatio flags mostly-code text', () => {
    expect(__test.codeRatio('hello there friend')).toBeLessThan(0.2)
    expect(__test.codeRatio('```ts\nconst x = 1;\n```')).toBeGreaterThan(0.5)
    expect(__test.codeRatio('/path/to/file.ts:1:1 broken')).toBeGreaterThan(0.2)
  })

  it('codeRatio does NOT double-count fenced content (LOC-79 batch-1 fix)', () => {
    // Common command shape: short natural-language prompt with one fenced
    // code snippet for context. Previously this got dropped because the
    // fence-internal chars were counted both via fenceLen AND the per-char
    // hit loop, pushing the ratio over the 0.6 threshold.
    const prompt = 'Refactor this code to handle the null case more gracefully and add tests:\n\n```ts\nfunction foo(x) { return x.bar }\n```\n\nThanks!'
    const ratio = __test.codeRatio(prompt)
    // Roughly half the chars are inside the fence. Ratio should land
    // comfortably under 0.6 (the drop threshold) so the prompt survives
    // command mining.
    expect(ratio).toBeLessThan(0.6)
  })

  it('slugFromPrompt strips stopwords and yields kebab', () => {
    const slug = __test.slugFromPrompt('Review this pull request carefully please')
    expect(slug).toBe('review-pull-request-carefully-please')
  })

  it('slugFromPrompt collapses to untitled-command on empty', () => {
    expect(__test.slugFromPrompt('the a an and or')).toBe('untitled-command')
  })
})

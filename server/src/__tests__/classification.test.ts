import { describe, it, expect } from 'vitest'
import { inferType } from '../scanner/classification'
import type { Skill } from '../scanner/types'

function makeSkill(type: Skill['type'], body: string): Pick<Skill, 'type' | 'body'> {
  return { type, body }
}

// --- Command-shaped detection ---

describe('inferType — command-shaped bodies', () => {
  it('flags a short imperative skill body as command-shaped (smoke test case)', () => {
    const result = inferType(makeSkill('skill', 'Generate a commit message for the staged changes'))
    expect(result).not.toBeNull()
    expect(result!.suggested).toBe('command')
    expect(result!.confidence).toBe('high')
    expect(result!.cues.length).toBeGreaterThanOrEqual(2)
  })

  it('flags a subagent with a short imperative body and no disclosure language as command-shaped', () => {
    const body = 'Build and run the test suite, then report results.'
    const result = inferType(makeSkill('subagent', body))
    expect(result).not.toBeNull()
    expect(result!.suggested).toBe('command')
    expect(result!.cues.some(c => /imperative/i.test(c))).toBe(true)
  })
})

// --- Subagent-shaped detection ---

describe('inferType — subagent-shaped bodies', () => {
  it('flags a skill with role-declaration opener and delegation language as subagent-shaped', () => {
    const body = [
      'You are an expert code reviewer.',
      'Delegate the analysis to specialized agents and coordinate the results autonomously.',
    ].join(' ')
    const result = inferType(makeSkill('skill', body))
    expect(result).not.toBeNull()
    expect(result!.suggested).toBe('subagent')
    expect(result!.cues.some(c => /role declaration/i.test(c))).toBe(true)
  })

  it('flags a command with "act as" opener and autonomous behavior as subagent-shaped', () => {
    const body = 'Act as a research assistant. Orchestrate web searches, coordinate findings, and delegate sub-tasks autonomously.'
    const result = inferType(makeSkill('command', body))
    expect(result).not.toBeNull()
    expect(result!.suggested).toBe('subagent')
    expect(result!.cues.some(c => /autonomous|delegate|orchestrat/i.test(c))).toBe(true)
  })
})

// --- Skill-shaped detection ---

describe('inferType — skill-shaped bodies', () => {
  it('flags a command body with "use when" and "this skill supports" as skill-shaped', () => {
    const body = [
      'Use when the user asks about test failures.',
      'This skill supports debugging workflows by analyzing error output and stack traces.',
    ].join(' ')
    const result = inferType(makeSkill('command', body))
    expect(result).not.toBeNull()
    expect(result!.suggested).toBe('skill')
    expect(result!.cues.some(c => /use when/i.test(c))).toBe(true)
  })

  it('flags a subagent body with "use when" and "if the user" as skill-shaped', () => {
    const body = [
      'Use when you need structured test analysis.',
      'If the user provides a test run output, parse the failures and suggest fixes.',
    ].join(' ')
    const result = inferType(makeSkill('subagent', body))
    expect(result).not.toBeNull()
    expect(result!.suggested).toBe('skill')
    expect(result!.cues.length).toBeGreaterThanOrEqual(2)
  })
})

// --- Null cases (no mismatch) ---

describe('inferType — returns null when correctly typed or ambiguous', () => {
  it('returns null for a skill that already has skill-type cues', () => {
    const body = 'Use when the user wants to analyze code. This skill supports refactoring by detecting patterns.'
    const result = inferType(makeSkill('skill', body))
    expect(result).toBeNull()
  })

  it('returns null for a command that already has command-type cues', () => {
    const body = 'Generate a PR description for the current branch.'
    const result = inferType(makeSkill('command', body))
    expect(result).toBeNull()
  })

  it('returns null for a body with no strong cues in either direction', () => {
    // Long body, no imperative opener, no disclosure, no role declaration
    const body = 'A ' + 'helpful '.repeat(120) + 'utility.'
    const result = inferType(makeSkill('skill', body))
    expect(result).toBeNull()
  })
})

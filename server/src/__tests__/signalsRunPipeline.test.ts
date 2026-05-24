import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { runSignalPipeline } from '../autoSkill/signals/runPipeline'
import { openSummaryCache } from '../autoSkill/signals/summaryCache'
import * as store from '../autoSkill/store'
import type { ConversationRecord, ConversationMessage } from '../extractors/types'

// ---- Fixtures ---------------------------------------------------------------

function msg(i: number, role: 'user' | 'assistant', content: string, opts: { offsetMin?: number } = {}): ConversationMessage {
  return {
    id: `m-${i}-${Math.random().toString(36).slice(2, 6)}`,
    role,
    content,
    timestamp: new Date(Date.UTC(2026, 4, 20, 12, opts.offsetMin ?? i, 0)).toISOString(),
  }
}

function conversation(id: string, messages: ConversationMessage[]): ConversationRecord {
  return {
    id,
    source: 'claude',
    sessionId: id,
    projectPath: '/work',
    startedAt: messages[0].timestamp,
    endedAt: messages[messages.length - 1].timestamp,
    messages,
  }
}

// Three near-identical "add vitest test" conversations — the kind of
// pattern the skill detector should pick up.
function vitestConvo(idx: number): ConversationRecord {
  const id = `claude:vitest-${idx}`
  return conversation(id, [
    msg(0, 'user',      'add a vitest test for the foo helper'),
    msg(1, 'assistant', 'sure, scaffolding now'),
    msg(2, 'user',      'great — now add a snapshot case'),
    msg(3, 'assistant', 'done. tests pass.'),
  ])
}

const VALID_SKILL_SYNTH = JSON.stringify({
  name: 'add-vitest-spec',
  description: 'Scaffold a vitest test for a helper',
  applicabilityCondition: 'When the user asks to add a vitest test',
  procedure: ['Read helper', 'Create *.test.ts', 'Write assertions', 'Run vitest'],
  terminationCondition: 'Test runs green',
  expectedOutput: 'A new .test.ts file',
})

const VALID_CONSISTENCY = JSON.stringify({
  holdouts: [
    { pass: true, reason: 'matches' },
    { pass: true, reason: 'matches' },
  ],
})

const VALID_SUMMARY = JSON.stringify({
  intent: 'add a vitest test for the foo helper',
  slotValues: { files: ['src/foo.ts'], tools: ['Read', 'Edit'], libraries: ['vitest'], mcps: [] },
  resolutionSteps: ['scaffold', 'write', 'run'],
  outcome: 'succeeded',
  stableApproach: true,
  subGoals: ['scaffold', 'snapshot'],
  toolSignature: ['Read', 'Edit'],
  invokedSkills: [],
  verbatimUserPrompts: ['add a vitest test for the foo helper'],
  correctionMarkers: [],
  personalizationSignals: [{ kind: 'test-framework', evidence: 'prefers vitest' }],
})

// ---- Test isolation ---------------------------------------------------------

let tmpHome: string
let realHomedir: () => string

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-pipeline-'))
  realHomedir = os.homedir
  ;(os as { homedir: () => string }).homedir = () => tmpHome
})
afterEach(() => {
  ;(os as { homedir: () => string }).homedir = realHomedir
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ---- Tests ------------------------------------------------------------------

describe('runSignalPipeline', () => {
  it('end-to-end: 3 similar vitest convos → 1 skill candidate persisted', async () => {
    const convos = [vitestConvo(1), vitestConvo(2), vitestConvo(3)]
    const cache = openSummaryCache(path.join(tmpHome, 'cache.json'))

    const result = await runSignalPipeline({
      model: 'test-model',
      sinceIso: '2026-05-01T00:00:00.000Z',
      conversationsOverride: convos,
      existingSkillsOverride: [],
      existingRuleFilesOverride: [],
      summaryCache: cache,
      summarizeFn: async () => VALID_SUMMARY,
      skillSynthFn: async () => VALID_SKILL_SYNTH,
      skillConsistencyFn: async () => VALID_CONSISTENCY,
      ruleClassifierFn: async (xs) => xs.map(() => true),
      subagentSynthFn: async () => JSON.stringify({
        name: 'x', description: 'x', constituentSkills: [], orchestrationPattern: ['x'], inputShape: 'x', outputShape: 'x',
      }),
      embedFn: async (t: string) => {
        // Same text → same vector so vitest convos cluster together.
        const v = t.toLowerCase().includes('vitest') ? [1, 0, 0] : [0, 1, 0]
        return v
      },
      skipOllamaCheck: true,
    })

    expect(result.conversationsProcessed).toBe(3)
    expect(result.summariesProduced).toBe(3)
    expect(result.clustersProduced).toBeGreaterThanOrEqual(1)
    expect(result.skillCandidates).toBeGreaterThanOrEqual(1)

    const persisted = store.readAll()
    expect(persisted.length).toBeGreaterThan(0)
    const skill = persisted.find(c => c.suggestedType === 'skill')
    expect(skill).toBeDefined()
    expect(skill?.applicabilityCondition).toBe('When the user asks to add a vitest test')
    expect(skill?.procedure?.length).toBe(4)
    expect(skill?.reasonForUser).toBeTruthy()
  })

  it('emits per-candidate breakdown counters', async () => {
    const convos = [vitestConvo(1), vitestConvo(2), vitestConvo(3)]
    const cache = openSummaryCache(path.join(tmpHome, 'cache.json'))

    const result = await runSignalPipeline({
      model: 'test-model',
      sinceIso: '2026-05-01T00:00:00.000Z',
      conversationsOverride: convos,
      existingSkillsOverride: [],
      existingRuleFilesOverride: [],
      summaryCache: cache,
      summarizeFn: async () => VALID_SUMMARY,
      skillSynthFn: async () => VALID_SKILL_SYNTH,
      skillConsistencyFn: async () => VALID_CONSISTENCY,
      ruleClassifierFn: async (xs) => xs.map(() => true),
      subagentSynthFn: async () => '{}',
      embedFn: async () => [1, 0, 0],
      skipOllamaCheck: true,
    })

    expect(typeof result.skillCandidates).toBe('number')
    expect(typeof result.ruleCandidates).toBe('number')
    expect(typeof result.commandCandidates).toBe('number')
    expect(typeof result.subagentCandidates).toBe('number')
  })

  it('rejects when no model is set', async () => {
    await expect(runSignalPipeline({
      model: '',
      conversationsOverride: [],
      skipOllamaCheck: true,
    })).rejects.toThrow(/no model selected/i)
  })

  it('skill synth fires once per cluster, not twice (LOC-79 batch-1 fix)', async () => {
    // Previously the orchestrator called detectSkills twice: once in the
    // Promise.all batch and once inside the subagent IIFE. Real Ollama would
    // pay 2× the synth + consistency cost per surviving cluster. Lock it in.
    const convos = [vitestConvo(1), vitestConvo(2), vitestConvo(3)]
    const cache = openSummaryCache(path.join(tmpHome, 'cache.json'))
    let synthCalls = 0
    let consistencyCalls = 0

    await runSignalPipeline({
      model: 'test-model',
      sinceIso: '2026-05-01T00:00:00.000Z',
      conversationsOverride: convos,
      existingSkillsOverride: [],
      existingRuleFilesOverride: [],
      summaryCache: cache,
      summarizeFn: async () => VALID_SUMMARY,
      skillSynthFn: async () => { synthCalls += 1; return VALID_SKILL_SYNTH },
      skillConsistencyFn: async () => { consistencyCalls += 1; return VALID_CONSISTENCY },
      ruleClassifierFn: async (xs) => xs.map(() => false),
      subagentSynthFn: async () => '{}',
      embedFn: async () => [1, 0, 0],
      skipOllamaCheck: true,
    })

    // Three convos collapse into one cluster on the same intent → one synth +
    // one consistency LLM call. The old buggy path would have been 2/2.
    expect(synthCalls).toBe(1)
    expect(consistencyCalls).toBe(1)
  })

  it('warnings include detector warnings (synth invalid for skill)', async () => {
    const convos = [vitestConvo(1), vitestConvo(2), vitestConvo(3)]
    const cache = openSummaryCache(path.join(tmpHome, 'cache.json'))

    const result = await runSignalPipeline({
      model: 'test-model',
      sinceIso: '2026-05-01T00:00:00.000Z',
      conversationsOverride: convos,
      existingSkillsOverride: [],
      existingRuleFilesOverride: [],
      summaryCache: cache,
      summarizeFn: async () => VALID_SUMMARY,
      // Skill synth always returns incomplete output → both attempts fail.
      skillSynthFn: async () => JSON.stringify({ name: '', description: 'x' }),
      skillConsistencyFn: async () => VALID_CONSISTENCY,
      ruleClassifierFn: async (xs) => xs.map(() => false),
      subagentSynthFn: async () => '{}',
      embedFn: async () => [1, 0, 0],
      skipOllamaCheck: true,
    })

    expect(result.skillCandidates).toBe(0)
    expect(result.detectorWarnings.some(w => w.startsWith('skill['))).toBe(true)
  })
})

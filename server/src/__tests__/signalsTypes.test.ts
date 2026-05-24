import { describe, it, expect } from 'vitest'
import type { Candidate } from '../autoSkill/types'
import type {
  SubGoalArc,
  ConversationSummary,
  IntentCluster,
} from '../autoSkill/signals'

describe('signal-detection pipeline scaffolding', () => {
  it('Candidate accepts the new rule suggestedType and per-kind fields', () => {
    const c: Candidate = {
      id: 'c1',
      signature: 'rule:always-x',
      name: 'Always X',
      description: 'Always do X',
      bodyDraft: '',
      suggestedType: 'rule',
      score: 0.5,
      status: 'pending',
      sourceRefs: [],
      createdAt: '2026-05-23T00:00:00Z',
      updatedAt: '2026-05-23T00:00:00Z',
      model: 'qwen2.5:3b',
      ruleText: 'Always do X.',
      suggestedSection: 'Conventions',
      reasonForUser: 'Appeared in 8 conversations',
      sourceClusterId: 'cluster-1',
    }
    expect(c.suggestedType).toBe('rule')
    expect(c.ruleText).toBe('Always do X.')
  })

  it('intermediate pipeline types are shape-stable', () => {
    const arc: SubGoalArc = {
      conversationId: 'conv-1',
      arcId: 'conv-1#0',
      startTurnIndex: 0,
      endTurnIndex: 12,
      triggerSignal: 'conversation-start',
    }
    const summary: ConversationSummary = {
      arcId: arc.arcId,
      conversationId: arc.conversationId,
      source: 'claude',
      startedAt: '2026-05-23T00:00:00Z',
      intent: 'fix flaky test',
      slotValues: { component: ['test-runner'] },
      resolutionSteps: ['rerun', 'inspect logs'],
      outcome: 'succeeded',
      stableApproach: true,
      subGoals: [],
      toolSignature: ['Read', 'Bash'],
      invokedSkills: [],
      verbatimUserPrompts: ['fix the flaky test'],
      correctionMarkers: [],
      personalizationSignals: [],
    }
    const cluster: IntentCluster = {
      clusterId: 'cluster-1',
      members: [arc.arcId],
      centroidIntent: summary.intent,
      centroidSlotValues: summary.slotValues,
      recurrenceCount: 1,
      dateSpan: { start: summary.startedAt, end: summary.startedAt },
      medianGapDays: 0,
      recencyDays: 0,
      commonToolSignature: summary.toolSignature,
      convergentApproach: summary.resolutionSteps,
      outcomeBreakdown: { succeeded: 1, failed: 0, abandoned: 0, partial: 0 },
    }
    expect(cluster.members).toContain(arc.arcId)
    expect(summary.outcome).toBe('succeeded')
  })
})

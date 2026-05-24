// Intermediate types for the signal-detection pipeline (LOC-69).
//
// These are pipeline-internal shapes — they flow phase-to-phase but never
// surface to the user. The user-facing artifact is the existing `Candidate`
// from `../types.ts`, which now carries optional per-kind fields populated by
// the detectors in Phase 3.
//
// Per the LOC-69 audit: do NOT add Candidate subclasses here. If a detector
// needs to emit something the user sees, extend `Candidate` instead.

export type SubGoalArc = {
  conversationId: string
  /** Stable id of the form "{conversationId}#{n}". */
  arcId: string
  startTurnIndex: number
  endTurnIndex: number
  /** Why Phase 0 split here. 'conversation-start' for the first arc of a convo. */
  triggerSignal:
    | 'topic-shift-phrase'
    | 'time-gap'
    | 'tool-shift'
    | 'llm-detected'
    | 'conversation-start'
}

export type ConversationSummary = {
  arcId: string
  conversationId: string
  source: 'claude' | 'cursor' | 'codex'
  /** ISO start timestamp of the arc (first turn). */
  startedAt: string
  intent: string
  slotValues: Record<string, string[]>
  resolutionSteps: string[]
  outcome: 'succeeded' | 'failed' | 'abandoned' | 'partial'
  stableApproach: boolean
  subGoals: string[]
  toolSignature: string[]
  invokedSkills: string[]
  verbatimUserPrompts: string[]
  correctionMarkers: Array<{ quote: string; kind: 'frustration' | 'reversal' }>
  personalizationSignals: Array<{ kind: string; evidence: string }>
}

export type IntentCluster = {
  clusterId: string
  /** arcIds of cluster members. */
  members: string[]
  centroidIntent: string
  centroidSlotValues: Record<string, string[]>
  recurrenceCount: number
  dateSpan: { start: string; end: string }
  medianGapDays: number
  recencyDays: number
  commonToolSignature: string[]
  /** Intersection of resolutionSteps across members — the convergent procedure. */
  convergentApproach: string[]
  outcomeBreakdown: {
    succeeded: number
    failed: number
    abandoned: number
    partial: number
  }
}

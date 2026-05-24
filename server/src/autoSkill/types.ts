// Candidate = the user-facing output of a digest run. Kept stable across
// runs (incremental dedup by slugified name + source signature).

export type CandidateType = 'skill' | 'command' | 'subagent' | 'rule'
export type CandidateStatus = 'pending' | 'accepted' | 'rejected'

export interface CandidateSourceRef {
  source: 'claude' | 'cursor' | 'codex'
  /** Same id the extractor produced — useful if we ever resurrect raw text. */
  conversationId: string
  /** Short snippet (≤120 chars) so the reviewer recognizes the conversation
   *  without us storing the full body. Per privacy decision #1. */
  excerpt: string
  /** ISO timestamp of the source conversation. */
  at: string
}

export interface ExistingMatch {
  skillId: string
  skillName: string
  skillPath: string
  matchKind: 'name' | 'description'
  similarity: number
}

export type ImprovementKind = 'add-to-description' | 'add-to-body' | 'no-improvement'

export interface ImprovementSuggestion {
  kind: ImprovementKind
  text: string
}

export interface ImprovementNotes {
  suggestions: ImprovementSuggestion[]
  comparedAt: string
  model: string
  /** Skill id we compared against — invalidates if the user later changes
   *  the underlying skill or the candidate's matched skill changes. */
  comparedSkillId: string
}

export interface Candidate {
  id: string
  /** Stable hash of (suggestedType + slug(name)) — used for dedup. */
  signature: string
  name: string
  description: string
  bodyDraft: string
  suggestedType: CandidateType
  /** 0-1, computed from sourceRefs.length × recency. */
  score: number
  status: CandidateStatus
  sourceRefs: CandidateSourceRef[]
  createdAt: string
  updatedAt: string
  /** Model that produced this candidate. */
  model: string
  /** If accepted via Phase 5, the path to the SKILL.md we wrote. */
  acceptedPath?: string
  /** Populated when an existing inventory skill looks like a duplicate. Recomputed
   *  on every fetch via the candidates route, so stays fresh as the user installs
   *  new skills. */
  existingMatch?: ExistingMatch | null
  /** Cached output of the compare-against-existing LLM pass. Populated only
   *  when the user clicks "Compare" on a matched row. */
  improvementNotes?: ImprovementNotes

  // --- Signal-detection pipeline enrichment (LOC-69). All optional; populated
  //     only when produced by the new pipeline (`useSignalPipeline` flag). The
  //     existing free-form digest never sets these.

  /** Plain-English explanation generated in pipeline Phase 6. */
  reasonForUser?: string
  /** Short verbatim snippets from source conversations, shown as evidence. */
  evidenceQuotes?: Array<{ conversationId: string; quote: string }>

  // Rule-only (suggestedType === 'rule')
  ruleText?: string
  suggestedSection?: string

  // Command-only (suggestedType === 'command')
  promptText?: string
  invocationCount?: number
  suggestedSlug?: string

  // Skill-only — S = (C, π, T, R) per arXiv 2602.20867
  applicabilityCondition?: string
  procedure?: string[]
  terminationCondition?: string
  expectedOutput?: string

  // Subagent-only (suggestedType === 'subagent')
  constituentSkills?: string[]
  orchestrationPattern?: string[]
  inputShape?: string
  outputShape?: string

  /** Pipeline provenance — the IntentCluster this candidate was promoted from. */
  sourceClusterId?: string
}

export interface DigestResult {
  candidatesCreated: number
  candidatesUpdated: number
  conversationsProcessed: number
  chunksProcessed: number
  warnings: string[]
  durationMs: number
  model: string
}

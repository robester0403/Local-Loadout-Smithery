// Unified conversation shape produced by every extractor. Same JSONL row
// regardless of source so downstream digest code doesn't have to branch.
//
// The text in `messages[].content` is the sensitive part — privacy policy
// (per planning_notes/SKILL_HARVESTER.md decision #1) is to delete these
// files after the digest run completes, keeping only short excerpts in the
// candidate sourceRefs[].

export type ConversationSource = 'claude' | 'cursor' | 'codex'

export type MessageRole = 'user' | 'assistant'

export interface ConversationMessage {
  /** Stable per source: Claude UUID, Cursor bubbleId, Codex msg id. */
  id: string
  role: MessageRole
  /** Flattened text. Tool-use blocks are summarized as `[tool: name]`. */
  content: string
  /** ISO 8601 timestamp if the source provides one, else empty string. */
  timestamp: string
  /** Working directory captured at the moment of this turn, when the source
   *  exposes one (currently only Claude Code). Falls back to the session-wide
   *  `ConversationRecord.projectPath` when absent. Consumed by the arc
   *  segmenter (LOC-71) for cwd-shift boundaries. */
  cwd?: string
}

export interface ConversationRecord {
  /** Stable id used for incremental extraction: <source>:<sessionId>. */
  id: string
  source: ConversationSource
  /** Session / composer / thread identifier within the source. */
  sessionId: string
  /** cwd or workspace path if known. */
  projectPath: string
  /** Earliest message timestamp. */
  startedAt: string
  /** Latest message timestamp. */
  endedAt: string
  messages: ConversationMessage[]
}

export interface ExtractResult {
  source: ConversationSource
  /** Conversations newly written this run. */
  added: number
  /** Conversations skipped because already present in the JSONL. */
  skipped: number
  /** Soft failures (parse errors, missing fields). */
  warnings: string[]
}

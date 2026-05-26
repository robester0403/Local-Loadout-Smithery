export type SkillType = 'skill' | 'command' | 'subagent' | 'mcp' | 'rule'

export interface MCPTool {
  name: string
  description?: string
  schemaBytes: number
}

export interface MCPRow {
  name: string
  kind: 'configured' | 'session-injected'
  scope?: 'global' | 'project'
  transport?: 'stdio' | 'sse' | 'http'
  tools: MCPTool[]
  schemaBytes: number | null
  status: 'ok' | 'unavailable' | 'unknown'
  statusReason?: string
  source?: string
  projectPath?: string
}

export interface ClassificationResult {
  suggested: SkillType
  confidence: 'high' | 'low'
  cues: string[]
}
export type Timeframe = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all'
export type SkillScope = 'global' | 'project'
export type HealthStatus = 'ok' | 'warn' | 'error'
export type SortKey = 'name' | 'type' | 'scope' | 'lastModified' | 'health' | 'activeTokens' | 'loadedTokens' | 'invocations' | 'insight'
export type Insight = 'removal-candidate' | 'winner' | null
export type SortDir = 'asc' | 'desc'

export interface HealthIssue {
  severity: 'warn' | 'error'
  message: string
}

export interface HealthResult {
  status: HealthStatus
  issues: HealthIssue[]
}

// LOC-95: informational diagnostics distinct from health. Hints the user
// can act on or ignore; no score impact.
export type DiagnosticKind = 'slash-in-path'

export interface Diagnostic {
  kind: DiagnosticKind
  offset: number
  matched: string
  artifactName: string
  suggestion: string
}

export interface SkillCostAxes {
  tokens: number
  dollars: number
}

export interface SkillUsageSummary {
  skillName: string
  invocations: number
  lastInvoked: string
  active: SkillCostAxes
  loaded: SkillCostAxes
  total: SkillCostAxes
}

export interface Skill {
  id: string
  name: string
  description: string
  version: string
  type: SkillType
  scope: SkillScope
  account: string
  projectId?: string
  path: string
  realpath: string
  isSymlink: boolean
  body: string
  frontmatter: Record<string, unknown>
  lastModified: string
  /** File birthtime (or mtime fallback) from the server. Drives the
   *  client-derived `isNew` flag via the `newSkillGraceDays` threshold. */
  installedAt: string
  /** LOC-12: derived field — `installedAt > now - newSkillGraceDays`. */
  isNew: boolean
  health: HealthResult
  disabled: boolean
  references: { name: string; source: 'body' | 'command' | 'frontmatter' }[]
  /** LOC-95: informational diagnostics computed during scan. May be empty. */
  diagnostics: Diagnostic[]
  activeDollars: number
  loadedDollars: number
  totalDollars: number
  activeTokens: number
  loadedTokens: number
  invocations: number
  bodyTokens?: number
  listingTokens?: number
  insight: Insight
  dormant: boolean
  lastInvoked: string
  bloat: boolean
  descLen: number
  suggestedType?: ClassificationResult | null
  mcpData?: MCPRow
}

export interface Filters {
  type: string[]
  scope: string[]
  issuesOnly: boolean
  reviewOnly: boolean
  newOnly: boolean
}

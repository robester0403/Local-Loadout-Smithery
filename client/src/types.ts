export type SkillType = 'skill' | 'command' | 'subagent' | 'mcp'

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
export type SortKey = 'name' | 'type' | 'scope' | 'lastModified' | 'health' | 'activeDollars' | 'loadedDollars' | 'totalDollars' | 'insight'
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
  health: HealthResult
  disabled: boolean
  references: { name: string; source: 'body' | 'command' | 'frontmatter' }[]
  /** LOC-95: informational diagnostics computed during scan. May be empty. */
  diagnostics: Diagnostic[]
  activeDollars: number
  loadedDollars: number
  totalDollars: number
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
}

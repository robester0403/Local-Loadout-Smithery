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
  activeDollars: number
  loadedDollars: number
  totalDollars: number
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

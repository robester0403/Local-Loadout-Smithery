import type { SkillReference } from './references'
export type { SkillReference } from './references'

export type SkillType = 'skill' | 'command' | 'subagent'
export type SkillScope = 'global' | 'project'
export type HealthStatus = 'ok' | 'warn' | 'error'

export interface HealthIssue {
  severity: 'warn' | 'error'
  message: string
}

export interface HealthResult {
  status: HealthStatus
  issues: HealthIssue[]
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
  references: SkillReference[]
}

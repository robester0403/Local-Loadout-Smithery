export type SkillType = 'skill' | 'command' | 'agent'
export type SkillScope = 'global' | 'project'
export type SortKey = 'name' | 'type' | 'scope' | 'account' | 'lastModified'
export type SortDir = 'asc' | 'desc'

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
}

export interface Filters {
  type: string
  scope: string
  account: string
}

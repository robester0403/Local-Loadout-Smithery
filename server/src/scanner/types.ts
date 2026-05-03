export type SkillType = 'skill' | 'command' | 'agent'
export type SkillScope = 'global' | 'project'

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

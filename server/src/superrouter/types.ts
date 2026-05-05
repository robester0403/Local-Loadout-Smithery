export interface GroupMember {
  skillId: string
  addedAt: string       // ISO8601
  contentHash: string   // SHA-256 of name + description at add time
}

export interface RoutingGroup {
  id: string
  name: string
  description: string
  keywords: string[]
  scope: 'global' | 'project'
  projectPath?: string  // required when scope === 'project'
  enabled: boolean
  members: GroupMember[]
  driftedMembers?: string[]  // computed at read time, not persisted
}

export interface SuperRouterState {
  globalEnabled: boolean
  useHook: boolean       // also install UserPromptSubmit hook for higher reliability
  groups: RoutingGroup[]
}

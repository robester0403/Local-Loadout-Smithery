import type { RoutingGroup } from './types'
import { hashContent } from './store'

export interface SkillSnapshot {
  id: string
  name: string
  description: string
}

export function computeDrift(groups: RoutingGroup[], inventory: SkillSnapshot[]): RoutingGroup[] {
  const skillMap = new Map(inventory.map(s => [s.id, s]))

  return groups.map(group => {
    const driftedMembers = group.members
      .filter(m => {
        const current = skillMap.get(m.skillId)
        if (!current) return false  // missing — handled separately, not drift
        const currentHash = hashContent(current.name, current.description)
        return currentHash !== m.contentHash
      })
      .map(m => m.skillId)

    return driftedMembers.length > 0 ? { ...group, driftedMembers } : group
  })
}

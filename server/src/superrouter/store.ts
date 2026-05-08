import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import type { RoutingGroup, SuperRouterState, GroupMember } from './types'

export const SUPERROUTER_DIR = path.join(os.homedir(), '.loadoutsmith', 'superrouter')
const GROUPS_FILE = path.join(SUPERROUTER_DIR, 'groups.json')

function ensureDirs(): void {
  fs.mkdirSync(path.join(SUPERROUTER_DIR, 'groups'), { recursive: true })
}

export function loadState(): SuperRouterState {
  ensureDirs()
  if (!fs.existsSync(GROUPS_FILE)) {
    return { globalEnabled: false, useHook: false, groups: [] }
  }
  try {
    return JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf-8')) as SuperRouterState
  } catch {
    return { globalEnabled: false, useHook: false, groups: [] }
  }
}

export function saveState(state: SuperRouterState): void {
  ensureDirs()
  const tmp = GROUPS_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
  fs.renameSync(tmp, GROUPS_FILE)
}

export function hashContent(name: string, description: string): string {
  return crypto.createHash('sha256').update(name + '\n' + description).digest('hex')
}

function generateId(): string {
  return crypto.randomBytes(8).toString('hex')
}

export function createGroup(data: {
  name: string
  description: string
  keywords: string[]
  scope: 'global' | 'project'
  projectPath?: string
}): RoutingGroup {
  const state = loadState()
  const group: RoutingGroup = {
    id: generateId(),
    name: data.name.trim(),
    description: data.description.trim(),
    keywords: data.keywords.map(k => k.trim()).filter(Boolean),
    scope: data.scope,
    ...(data.projectPath ? { projectPath: data.projectPath } : {}),
    enabled: false,
    members: [],
  }
  state.groups.push(group)
  saveState(state)
  return group
}

export function updateGroup(
  id: string,
  data: Partial<Pick<RoutingGroup, 'name' | 'description' | 'keywords' | 'scope' | 'projectPath' | 'enabled'>>,
): RoutingGroup {
  const state = loadState()
  const idx = state.groups.findIndex(g => g.id === id)
  if (idx === -1) throw new Error(`Group not found: ${id}`)
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) as typeof data
  state.groups[idx] = { ...state.groups[idx]!, ...clean }
  saveState(state)
  return state.groups[idx]!
}

export function deleteGroup(id: string): void {
  const state = loadState()
  state.groups = state.groups.filter(g => g.id !== id)
  saveState(state)
  const routingFile = path.join(SUPERROUTER_DIR, 'groups', id + '.md')
  if (fs.existsSync(routingFile)) fs.unlinkSync(routingFile)
}

export function addMember(
  groupId: string,
  skillId: string,
  name: string,
  description: string,
): GroupMember {
  const state = loadState()
  const group = state.groups.find(g => g.id === groupId)
  if (!group) throw new Error(`Group not found: ${groupId}`)
  if (group.members.some(m => m.skillId === skillId)) throw new Error('Skill already in group')
  const member: GroupMember = {
    skillId,
    addedAt: new Date().toISOString(),
    contentHash: hashContent(name, description),
  }
  group.members.push(member)
  saveState(state)
  return member
}

export function removeMember(groupId: string, skillId: string): void {
  const state = loadState()
  const group = state.groups.find(g => g.id === groupId)
  if (!group) throw new Error(`Group not found: ${groupId}`)
  group.members = group.members.filter(m => m.skillId !== skillId)
  saveState(state)
}

export function setGlobalEnabled(enabled: boolean): void {
  const state = loadState()
  state.globalEnabled = enabled
  saveState(state)
}

export function setUseHook(useHook: boolean): void {
  const state = loadState()
  state.useHook = useHook
  saveState(state)
}

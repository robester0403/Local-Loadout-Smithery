import type { Skill, SkillUsageSummary, Timeframe, MCPRow } from './types'

export interface SampleTurn {
  skillName: string
  listingTokens: number
  effectiveTokens: number
  isFirstTurn: boolean
  dollars: number
  model: string
  formula: string
}

export interface BreakdownTurn {
  sessionFile: string
  ts: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  dollars: number
  attribution: 'active' | 'loaded'
  model: string
}

export interface BreakdownSession {
  sessionFile: string
  turns: BreakdownTurn[]
}

async function parseResponse<T>(res: Response): Promise<T> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error(`Server error ${res.status}: non-JSON response`)
  }
  if (!res.ok) {
    const msg = (body as { error?: string }).error ?? `Server error ${res.status}`
    throw new Error(msg)
  }
  return body as T
}

export async function fetchInventory(): Promise<Skill[]> {
  const res = await fetch('/api/inventory')
  const data = await parseResponse<{ skills: Skill[] }>(res)
  return data.skills
}

export async function fetchUsageAggregate(timeframe?: Timeframe): Promise<SkillUsageSummary[]> {
  const qs = timeframe && timeframe !== 'all' ? `?timeframe=${timeframe}` : ''
  const res = await fetch(`/api/usage/aggregate${qs}`)
  const data = await parseResponse<{ summaries: SkillUsageSummary[] }>(res)
  return data.summaries
}

export async function openSkill(id: string): Promise<void> {
  const res = await fetch(`/api/skills/${encodeURIComponent(id)}/open`, { method: 'POST' })
  await parseResponse<{ ok: boolean }>(res)
}

export async function setSkillDisabled(id: string, disabled: boolean): Promise<void> {
  const action = disabled ? 'disable' : 'enable'
  const res = await fetch(`/api/skills/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
  await parseResponse<{ ok: boolean }>(res)
}

export async function fetchSampleTurn(timeframe?: Timeframe): Promise<SampleTurn | null> {
  const qs = timeframe && timeframe !== 'all' ? `?timeframe=${timeframe}` : ''
  const res = await fetch(`/api/usage/sample-turn${qs}`)
  const data = await parseResponse<{ sample: SampleTurn | null }>(res)
  return data.sample
}

export async function fetchCostBreakdown(skillId: string, timeframe?: Timeframe): Promise<BreakdownSession[]> {
  const qs = timeframe && timeframe !== 'all' ? `?timeframe=${timeframe}` : ''
  const res = await fetch(`/api/usage/breakdown/${encodeURIComponent(skillId)}${qs}`)
  const data = await parseResponse<{ breakdown: BreakdownSession[] }>(res)
  return data.breakdown
}

export interface ProfilesData {
  profiles: Record<string, string[]>
  activeProfile: string | null
}

export async function fetchProfiles(): Promise<ProfilesData> {
  const res = await fetch('/api/profiles')
  return parseResponse<ProfilesData>(res)
}

export async function createProfile(name: string, skillIds: string[]): Promise<void> {
  const res = await fetch('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, skillIds }),
  })
  await parseResponse<{ ok: boolean }>(res)
}

export async function deleteProfile(name: string): Promise<void> {
  const res = await fetch(`/api/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' })
  await parseResponse<{ ok: boolean }>(res)
}

export async function activateProfile(name: string | null): Promise<void> {
  const slug = name === null ? '__all__' : encodeURIComponent(name)
  const res = await fetch(`/api/profiles/${slug}/activate`, { method: 'POST' })
  await parseResponse<{ ok: boolean }>(res)
}

export interface ReclassifyResult {
  from: string
  to: string
  newId: string
}

export async function reclassifySkill(id: string, newType: string): Promise<ReclassifyResult> {
  const res = await fetch(`/api/skills/${encodeURIComponent(id)}/reclassify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newType }),
  })
  return parseResponse<ReclassifyResult>(res)
}

export async function launchClaude(prompt: string): Promise<{ platform: string; launched?: boolean }> {
  const res = await fetch('/api/launch-claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  return parseResponse<{ ok: boolean; platform: string; launched?: boolean }>(res)
}

// ─── MCP Usage ───────────────────────────────────────────────────────────────

export interface MCPToolUsage { name: string; calls: number; lastInvoked: string }
export interface MCPUsageSummary {
  serverName: string
  invocations: number
  lastInvoked: string
  tokens: number
  dollars: number
  tools: MCPToolUsage[]
}
export interface MCPRelationship { skillName: string; serverName: string; calls: number }

export async function fetchMCPUsage(timeframe?: Timeframe): Promise<MCPUsageSummary[]> {
  const qs = timeframe && timeframe !== 'all' ? `?timeframe=${timeframe}` : ''
  const res = await fetch(`/api/mcp/usage${qs}`)
  return (await parseResponse<{ summaries: MCPUsageSummary[] }>(res)).summaries
}

export async function fetchMCPRelationships(): Promise<MCPRelationship[]> {
  const res = await fetch('/api/mcp/relationships')
  return (await parseResponse<{ relationships: MCPRelationship[] }>(res)).relationships
}

// ─── MCP Inventory ───────────────────────────────────────────────────────────

export async function fetchMCPInventory(): Promise<MCPRow[]> {
  const res = await fetch('/api/mcp/inventory')
  return (await parseResponse<{ servers: MCPRow[] }>(res)).servers
}

export async function refreshMCPInventory(): Promise<MCPRow[]> {
  const res = await fetch('/api/mcp/refresh', { method: 'POST' })
  return (await parseResponse<{ servers: MCPRow[] }>(res)).servers
}

// ─── Uninstall / Trash ───────────────────────────────────────────────────────

export interface UninstalledEntry {
  id: string
  name: string
  description: string
  type: string
  scope: string
  account: string
  originalPath: string
  uninstalledAt: string
}

export async function fetchUninstalled(): Promise<UninstalledEntry[]> {
  const res = await fetch('/api/uninstalled')
  return (await parseResponse<{ entries: UninstalledEntry[] }>(res)).entries
}

export async function uninstallSkillApi(id: string): Promise<void> {
  const res = await fetch(`/api/skills/${encodeURIComponent(id)}/uninstall`, { method: 'POST' })
  await parseResponse<{ ok: boolean }>(res)
}

export async function restoreSkillApi(id: string): Promise<void> {
  const res = await fetch(`/api/uninstalled/${encodeURIComponent(id)}/restore`, { method: 'POST' })
  await parseResponse<{ ok: boolean; restoredPath: string }>(res)
}

export async function permanentDeleteApi(id: string): Promise<void> {
  const res = await fetch(`/api/uninstalled/${encodeURIComponent(id)}`, { method: 'DELETE' })
  await parseResponse<{ ok: boolean }>(res)
}

// ─── SuperRouter ─────────────────────────────────────────────────────────────

export interface SRGroupMember {
  skillId: string
  addedAt: string
  contentHash: string
}

export interface SRGroup {
  id: string
  name: string
  description: string
  keywords: string[]
  scope: 'global' | 'project'
  projectPath?: string
  enabled: boolean
  members: SRGroupMember[]
  driftedMembers?: string[]
}

export interface SuperRouterStateData {
  globalEnabled: boolean
  useHook: boolean
  groups: SRGroup[]
  hookInstalled: boolean
}

export async function fetchSuperRouterState(): Promise<SuperRouterStateData> {
  const res = await fetch('/api/superrouter/state')
  return parseResponse<SuperRouterStateData>(res)
}

export async function superRouterGlobalToggle(opts: { enabled?: boolean; useHook?: boolean }): Promise<void> {
  const res = await fetch('/api/superrouter/global-toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  await parseResponse<{ ok: boolean }>(res)
}

export async function createSRGroup(data: {
  name: string; description: string; keywords: string[]
  scope: 'global' | 'project'; projectPath?: string
}): Promise<SRGroup> {
  const res = await fetch('/api/superrouter/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return (await parseResponse<{ group: SRGroup }>(res)).group
}

export async function updateSRGroup(
  id: string,
  data: Partial<{ name: string; description: string; keywords: string[]; scope: 'global' | 'project'; projectPath: string; enabled: boolean }>,
): Promise<SRGroup> {
  const res = await fetch(`/api/superrouter/groups/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return (await parseResponse<{ group: SRGroup }>(res)).group
}

export async function deleteSRGroup(id: string): Promise<void> {
  const res = await fetch(`/api/superrouter/groups/${encodeURIComponent(id)}`, { method: 'DELETE' })
  await parseResponse<{ ok: boolean }>(res)
}

export async function addSRMember(groupId: string, skillId: string, name: string, description: string): Promise<void> {
  const res = await fetch(
    `/api/superrouter/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(skillId)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description }) },
  )
  await parseResponse<{ member: SRGroupMember }>(res)
}

export async function removeSRMember(groupId: string, skillId: string): Promise<void> {
  const res = await fetch(
    `/api/superrouter/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(skillId)}`,
    { method: 'DELETE' },
  )
  await parseResponse<{ ok: boolean }>(res)
}

// ─── Cursor activity ────────────────────────────────────────────────────────

export interface CursorSkillUsage {
  skill: string
  activations: number
  sessions: number
  /** ms epoch; 0 if no timestamp available. */
  lastInvoked: number
}

export interface CursorUsageReport {
  /** True when the Cursor SQLite was found on the host. */
  available: boolean
  skills: CursorSkillUsage[]
  totalActivations: number
  distinctSessions: number
}

export async function fetchCursorUsage(): Promise<CursorUsageReport> {
  const res = await fetch('/api/cursor/usage')
  return parseResponse<CursorUsageReport>(res)
}

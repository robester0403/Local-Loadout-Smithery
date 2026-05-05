import type { Skill, SkillUsageSummary, Timeframe } from './types'

export interface SampleTurn {
  skillName: string
  skillBodyBytes: number
  totalBodyBytes: number
  turnInputTokens: number
  turnCacheCreateTokens: number
  turnCacheReadTokens: number
  attributedTokens: number
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

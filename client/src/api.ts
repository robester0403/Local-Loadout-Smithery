import type { Skill, SkillUsageSummary } from './types'

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

export async function fetchUsageAggregate(): Promise<SkillUsageSummary[]> {
  const res = await fetch('/api/usage/aggregate')
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

export async function fetchSampleTurn(): Promise<SampleTurn | null> {
  const res = await fetch('/api/usage/sample-turn')
  const data = await parseResponse<{ sample: SampleTurn | null }>(res)
  return data.sample
}

export async function fetchCostBreakdown(skillId: string): Promise<BreakdownSession[]> {
  const res = await fetch(`/api/usage/breakdown/${encodeURIComponent(skillId)}`)
  const data = await parseResponse<{ breakdown: BreakdownSession[] }>(res)
  return data.breakdown
}

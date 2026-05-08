import { computeActiveCost, type SkillBodyInfo } from './active'
import { computeLoadedCost, type LoadedSkillInput } from './loaded'
import { discoverAllSkills } from '../scanner'

export interface SkillCostAxes {
  tokens: number
  dollars: number
}

export interface SkillCostSummary {
  skillName: string
  invocations: number
  lastInvoked: string
  bodyBytes: number      // listing bytes (name + description), kept for API compat
  loadedTurns: number
  active: SkillCostAxes
  loaded: SkillCostAxes
  total: SkillCostAxes
}

// Combines LoadedSkillInput with optional body info for active cost.
// When bodyTokens is absent or 0, the skill contributes nothing to active cost.
export interface SkillCostInput extends LoadedSkillInput {
  bodyBytes?: number
  bodyTokens?: number
}

export function computeSkillAggregate(skills?: SkillCostInput[], since?: Date): SkillCostSummary[] {
  let bodyInfoList: SkillBodyInfo[]
  let loadedInputList: LoadedSkillInput[]

  if (skills === undefined) {
    const discovered = discoverAllSkills()
    bodyInfoList = discovered.map(s => ({ name: s.name, bodyBytes: s.bodyBytes, bodyTokens: s.bodyTokens }))
    loadedInputList = discovered.map(s => ({
      name: s.name,
      description: s.description,
      type: s.type,
      listingBytes: s.listingBytes,
      listingTokens: s.listingTokens,
    }))
  } else {
    bodyInfoList = skills
      .filter(s => (s.bodyTokens ?? 0) > 0)
      .map(s => ({ name: s.name, bodyBytes: s.bodyBytes ?? 0, bodyTokens: s.bodyTokens! }))
    loadedInputList = skills
  }

  const activeEntries = computeActiveCost(bodyInfoList, since)
  const loadedEntries = computeLoadedCost(loadedInputList, since)

  const summaries = new Map<string, SkillCostSummary>()

  for (const a of activeEntries) {
    const activeTokens = a.cacheCreationTokens + a.cacheReadTokens
    summaries.set(a.skillName, {
      skillName: a.skillName,
      invocations: a.activations,
      lastInvoked: a.lastActivated,
      bodyBytes: 0,
      loadedTurns: 0,
      active: { tokens: activeTokens, dollars: a.totalDollars },
      loaded: { tokens: 0, dollars: 0 },
      total: { tokens: activeTokens, dollars: a.totalDollars },
    })
  }

  for (const l of loadedEntries) {
    const loadedTokens = l.cacheCreationTokens + l.cacheReadTokens
    const existing = summaries.get(l.skillName)
    if (existing) {
      existing.bodyBytes = l.listingBytes
      existing.loadedTurns = l.loadedTurns
      existing.loaded = { tokens: loadedTokens, dollars: l.totalDollars }
      existing.total.tokens += loadedTokens
      existing.total.dollars += l.totalDollars
    } else {
      summaries.set(l.skillName, {
        skillName: l.skillName,
        invocations: 0,
        lastInvoked: '',
        bodyBytes: l.listingBytes,
        loadedTurns: l.loadedTurns,
        active: { tokens: 0, dollars: 0 },
        loaded: { tokens: loadedTokens, dollars: l.totalDollars },
        total: { tokens: loadedTokens, dollars: l.totalDollars },
      })
    }
  }

  return Array.from(summaries.values()).sort((a, b) => b.total.dollars - a.total.dollars)
}

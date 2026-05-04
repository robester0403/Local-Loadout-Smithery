import { computeActiveCost } from './attributor'
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
  bodyBytes: number
  loadedTurns: number
  active: SkillCostAxes
  loaded: SkillCostAxes
  total: SkillCostAxes
}

export function computeSkillAggregate(skills?: LoadedSkillInput[], since?: Date): SkillCostSummary[] {
  const list = skills ?? discoverAllSkills().map(s => ({ name: s.name, description: s.description, type: s.type }))
  const validSkills = new Set(list.map(s => s.name))

  const activeEntries = computeActiveCost(validSkills, since)
  const loadedEntries = computeLoadedCost(list, since)

  const summaries = new Map<string, SkillCostSummary>()

  for (const a of activeEntries) {
    const activeTokens =
      a.inputTokens + a.outputTokens + a.cacheCreationTokens + a.cacheReadTokens
    summaries.set(a.skillName, {
      skillName: a.skillName,
      invocations: a.invocations,
      lastInvoked: a.lastInvoked,
      bodyBytes: 0,
      loadedTurns: 0,
      active: { tokens: activeTokens, dollars: a.totalDollars },
      loaded: { tokens: 0, dollars: 0 },
      total: { tokens: activeTokens, dollars: a.totalDollars },
    })
  }

  for (const l of loadedEntries) {
    const loadedTokens = l.inputTokens + l.cacheCreationTokens + l.cacheReadTokens
    const existing = summaries.get(l.skillName)
    if (existing) {
      existing.bodyBytes = l.bodyBytes
      existing.loadedTurns = l.loadedTurns
      existing.loaded = { tokens: loadedTokens, dollars: l.totalDollars }
      existing.total.tokens += loadedTokens
      existing.total.dollars += l.totalDollars
    } else {
      summaries.set(l.skillName, {
        skillName: l.skillName,
        invocations: 0,
        lastInvoked: '',
        bodyBytes: l.bodyBytes,
        loadedTurns: l.loadedTurns,
        active: { tokens: 0, dollars: 0 },
        loaded: { tokens: loadedTokens, dollars: l.totalDollars },
        total: { tokens: loadedTokens, dollars: l.totalDollars },
      })
    }
  }

  return Array.from(summaries.values()).sort((a, b) => b.total.dollars - a.total.dollars)
}

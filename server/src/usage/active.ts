import fs from 'fs'
import path from 'path'
import { getPricing, toDollars } from './pricing'
import { findSessionFiles } from './parser'
import { discoverAllSkills } from '../scanner'
import { detectActivations } from './activation'

export interface ActiveCostEntry {
  skillName: string
  bodyBytes: number
  bodyTokens: number
  activations: number          // count of activation events for this skill
  activeTurns: number          // total turns where body was in context
  cacheCreationTokens: number  // body tokens charged at cache_create rate (one per activation)
  cacheReadTokens: number      // body tokens charged at cache_read rate (subsequent turns)
  totalDollars: number
  lastActivated: string        // ISO timestamp of most recent activation
}

export interface SkillBodyInfo {
  name: string
  bodyBytes: number
  bodyTokens: number
}

interface WalkTurn {
  timestamp: string
  isAssistant: boolean
  isCompaction: boolean
  model: string
}

function parseSessionTurns(filePath: string): WalkTurn[] {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return []
  }

  const turns: WalkTurn[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }

    const type = obj['type']
    const ts = typeof obj['timestamp'] === 'string' ? obj['timestamp'] : ''
    const msg = obj['message'] as Record<string, unknown> | undefined

    if (type === 'user') {
      turns.push({ timestamp: ts, isAssistant: false, isCompaction: false, model: '' })
      continue
    }
    if (type !== 'assistant') continue
    if (!msg || msg['role'] !== 'assistant') continue

    const contextMgmt = msg['context_management']
    const isCompaction = contextMgmt != null && contextMgmt !== null
    const model = typeof msg['model'] === 'string' ? msg['model'] : ''
    turns.push({ timestamp: ts, isAssistant: true, isCompaction, model })
  }

  // Sort by timestamp — must match activation.ts's sort order so turnIndex aligns.
  turns.sort((a, b) => {
    if (!a.timestamp) return -1
    if (!b.timestamp) return 1
    return a.timestamp.localeCompare(b.timestamp)
  })

  return turns
}

export function computeActiveCost(skills?: SkillBodyInfo[], since?: Date): ActiveCostEntry[] {
  const skillList =
    skills ??
    discoverAllSkills()
      // Subagents run in their own context — their body is never injected into
      // the parent session's cache, so they cannot accumulate active cost.
      .filter(s => s.type !== 'subagent')
      .map(s => ({
        name: s.name,
        bodyBytes: s.bodyBytes,
        bodyTokens: s.bodyTokens,
      }))

  // Skills with zero bodyTokens have no detectable body — exclude from active cost.
  const withBody = skillList.filter(s => s.bodyTokens > 0)
  if (withBody.length === 0) return []

  const skillMap = new Map(withBody.map(s => [s.name, s]))
  const tokenInfos = withBody.map(s => ({ name: s.name, bodyTokens: s.bodyTokens }))

  // Detect activations WITHOUT since — we need full history to correctly track which
  // skills are in context at turns after `since` (skills activated before since remain active).
  const allEvents = detectActivations(tokenInfos)

  // Index: sessionId → Map<turnIndex, string[]>
  const bySession = new Map<string, Map<number, string[]>>()
  for (const event of allEvents) {
    if (event.injectedSkills.length === 0) continue
    let byTurn = bySession.get(event.sessionId)
    if (!byTurn) {
      byTurn = new Map()
      bySession.set(event.sessionId, byTurn)
    }
    const prev = byTurn.get(event.turnIndex) ?? []
    byTurn.set(event.turnIndex, [...prev, ...event.injectedSkills])
  }

  const acc = new Map<string, ActiveCostEntry>()

  for (const filePath of findSessionFiles()) {
    const sessionId = path.basename(filePath, '.jsonl')
    const byTurn = bySession.get(sessionId)

    const turns = parseSessionTurns(filePath)
    const activeSet = new Set<string>()
    let turnIndex = -1

    for (const turn of turns) {
      if (!turn.isAssistant) continue

      turnIndex++

      if (turn.isCompaction) {
        activeSet.clear()
        continue
      }

      const newlyActivated = byTurn ? (byTurn.get(turnIndex) ?? []) : []

      // For pre-since turns: update state only, don't charge cost.
      const beforeSince = since && turn.timestamp && new Date(turn.timestamp) < since
      if (beforeSince) {
        for (const name of newlyActivated) activeSet.add(name)
        continue
      }

      const pricing = getPricing(turn.model)
      const newSet = new Set(newlyActivated)

      // Charge cache_create for newly activated skills (body entering cache this turn).
      for (const name of newlyActivated) {
        const info = skillMap.get(name)
        if (!info) continue

        activeSet.add(name)

        let entry = acc.get(name)
        if (!entry) {
          entry = {
            skillName: name,
            bodyBytes: info.bodyBytes,
            bodyTokens: info.bodyTokens,
            activations: 0,
            activeTurns: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalDollars: 0,
            lastActivated: '',
          }
          acc.set(name, entry)
        }

        entry.activations++
        entry.activeTurns++
        entry.cacheCreationTokens += info.bodyTokens
        if (turn.timestamp && (!entry.lastActivated || turn.timestamp > entry.lastActivated)) {
          entry.lastActivated = turn.timestamp
        }
        if (pricing) {
          entry.totalDollars += toDollars(info.bodyTokens, pricing.cacheWritePerM)
        }
      }

      // Charge cache_read for skills already in context (body already cached).
      for (const name of activeSet) {
        if (newSet.has(name)) continue

        const info = skillMap.get(name)
        if (!info) continue

        let entry = acc.get(name)
        if (!entry) {
          entry = {
            skillName: name,
            bodyBytes: info.bodyBytes,
            bodyTokens: info.bodyTokens,
            activations: 0,
            activeTurns: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalDollars: 0,
            lastActivated: '',
          }
          acc.set(name, entry)
        }

        entry.activeTurns++
        entry.cacheReadTokens += info.bodyTokens
        if (pricing) {
          entry.totalDollars += toDollars(info.bodyTokens, pricing.cacheReadPerM)
        }
      }
    }
  }

  return Array.from(acc.values()).sort((a, b) => b.totalDollars - a.totalDollars)
}

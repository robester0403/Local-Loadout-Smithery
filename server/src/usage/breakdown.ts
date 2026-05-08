import fs from 'fs'
import path from 'path'
import { discoverAllSkills } from '../scanner'
import { findSessionFiles } from './parser'
import { getPricing, toDollars } from './pricing'
import {
  listingBytesFor,
  listingTokensFor,
  LISTING_BUDGET_BYTES,
} from './loaded'
import { detectActivations } from './activation'
import type { SkillType } from '../scanner/types'

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

interface ParsedTurn {
  timestamp: string
  isAssistant: boolean
  isCompaction: boolean
  model: string
  sessionId: string
  inputT: number
  ccT: number
  crT: number
}

function parseSession(filePath: string): ParsedTurn[] {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return []
  }

  const turns: ParsedTurn[] = []
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
    const sessionId = typeof obj['sessionId'] === 'string' ? obj['sessionId'] : ''
    const msg = obj['message'] as Record<string, unknown> | undefined

    if (type === 'user') {
      turns.push({
        timestamp: ts, isAssistant: false, isCompaction: false,
        model: '', sessionId, inputT: 0, ccT: 0, crT: 0,
      })
      continue
    }
    if (type !== 'assistant') continue
    if (!msg || msg['role'] !== 'assistant') continue

    const usage = msg['usage'] as Record<string, unknown> | undefined
    const inputT = typeof usage?.['input_tokens'] === 'number' ? (usage['input_tokens'] as number) : 0
    const ccT = typeof usage?.['cache_creation_input_tokens'] === 'number' ? (usage['cache_creation_input_tokens'] as number) : 0
    const crT = typeof usage?.['cache_read_input_tokens'] === 'number' ? (usage['cache_read_input_tokens'] as number) : 0

    const ctx = msg['context_management']
    const isCompaction = ctx != null && ctx !== null
    const model = typeof msg['model'] === 'string' ? msg['model'] : ''

    turns.push({
      timestamp: ts, isAssistant: true, isCompaction,
      model, sessionId, inputT, ccT, crT,
    })
  }

  // Sort by timestamp — must match activation.ts so turnIndex aligns.
  turns.sort((a, b) => {
    if (!a.timestamp) return -1
    if (!b.timestamp) return 1
    return a.timestamp.localeCompare(b.timestamp)
  })

  return turns
}

export function breakdownForSkill(
  skillName: string,
  skillDescription: string,
  skillType: SkillType,
  maxTurns = 100,
  since?: Date,
): BreakdownSession[] {
  const allSkills = discoverAllSkills()
  const targetSkill = allSkills.find(s => s.name === skillName)
  // Subagents never have their body cached in the parent session, so they
  // cannot accumulate active cost. Mirror the filter applied in aggregate.ts.
  const skillBodyTokens =
    targetSkill && targetSkill.type !== 'subagent' ? targetSkill.bodyTokens : 0

  // Listing-share scaling — mirrors loaded.ts.
  const prepared = allSkills
    .filter(s => s.type !== 'command')
    .map(s => ({
      name: s.name,
      listingBytes: listingBytesFor(s.name, s.description),
    }))
    .filter(s => s.listingBytes > 0)
  const rawTotalBytes = prepared.reduce((sum, s) => sum + s.listingBytes, 0)
  const effectiveScale = rawTotalBytes > 0 ? Math.min(1, LISTING_BUDGET_BYTES / rawTotalBytes) : 0
  const skillListingTokens =
    skillType !== 'command'
      ? listingTokensFor(skillName, skillDescription) * effectiveScale
      : 0

  // Detect activations across full history (not filtered by `since`) so that
  // skills activated before the window are still recognized as in-context after.
  const tokenInfos = allSkills
    .filter(s => s.bodyTokens > 0 && s.type !== 'subagent')
    .map(s => ({ name: s.name, bodyTokens: s.bodyTokens }))
  const allEvents = detectActivations(tokenInfos)

  // sessionId → turn indices where this skill was newly activated.
  const activationsForSkill = new Map<string, Set<number>>()
  for (const ev of allEvents) {
    if (!ev.injectedSkills.includes(skillName)) continue
    let set = activationsForSkill.get(ev.sessionId)
    if (!set) {
      set = new Set<number>()
      activationsForSkill.set(ev.sessionId, set)
    }
    set.add(ev.turnIndex)
  }

  // Active rows are emitted per-turn (each one is interesting: when the body
  // entered cache, when it stayed cached). Loaded rows are uniform tiny charges
  // on every assistant turn — there can be tens of thousands of them per skill.
  // We aggregate loaded into a single synthetic row per session so the modal
  // total still equals the inventory's Active$ + Loaded$ exactly, without
  // flooding the response. (`maxTurns` is retained for compatibility but only
  // applies as a sanity bound; with the new shape it is rarely hit.)
  const activeRowsByFile = new Map<string, BreakdownTurn[]>()
  interface LoadedAccum {
    turns: number
    cacheCreationTokens: number
    cacheReadTokens: number
    dollars: number
    firstTs: string
    lastTs: string
    model: string
  }
  const loadedAccByFile = new Map<string, LoadedAccum>()

  for (const filePath of findSessionFiles()) {
    const sessionFile = path.basename(filePath, '.jsonl')
    const turns = parseSession(filePath)
    const newlyActivatedTurns = activationsForSkill.get(sessionFile) ?? new Set<number>()

    let active = false
    let turnIndex = -1
    const seenSessionIds = new Set<string>()  // first-turn tracking for loaded share

    for (const turn of turns) {
      if (!turn.isAssistant) continue
      turnIndex++

      let isNewActivation = false
      let willEmitActive = false
      if (turn.isCompaction) {
        active = false
      } else {
        isNewActivation = newlyActivatedTurns.has(turnIndex)
        if (isNewActivation || active) willEmitActive = true
        if (isNewActivation) active = true
      }

      const beforeSince = since && turn.timestamp && new Date(turn.timestamp) < since
      if (beforeSince) continue

      const pricing = getPricing(turn.model)

      if (willEmitActive && skillBodyTokens > 0 && pricing) {
        const dollars = isNewActivation
          ? toDollars(skillBodyTokens, pricing.cacheWritePerM)
          : toDollars(skillBodyTokens, pricing.cacheReadPerM)
        const list = activeRowsByFile.get(sessionFile) ?? []
        list.push({
          sessionFile,
          ts: turn.timestamp,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: isNewActivation ? skillBodyTokens : 0,
          cacheReadTokens: isNewActivation ? 0 : skillBodyTokens,
          dollars,
          attribution: 'active',
          model: turn.model,
        })
        activeRowsByFile.set(sessionFile, list)
      }

      const hasUsage = turn.inputT + turn.ccT + turn.crT > 0
      if (skillType !== 'command' && hasUsage && skillListingTokens > 0 && pricing) {
        const isFirstTurnLoaded = !seenSessionIds.has(turn.sessionId)
        if (turn.sessionId) seenSessionIds.add(turn.sessionId)
        const dollars = isFirstTurnLoaded
          ? toDollars(skillListingTokens, pricing.cacheWritePerM)
          : toDollars(skillListingTokens, pricing.cacheReadPerM)
        if (dollars >= 0.000001) {
          let acc = loadedAccByFile.get(sessionFile)
          if (!acc) {
            acc = {
              turns: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
              dollars: 0, firstTs: turn.timestamp, lastTs: turn.timestamp, model: turn.model,
            }
            loadedAccByFile.set(sessionFile, acc)
          }
          acc.turns++
          if (isFirstTurnLoaded) acc.cacheCreationTokens += Math.round(skillListingTokens)
          else acc.cacheReadTokens += Math.round(skillListingTokens)
          acc.dollars += dollars
          if (turn.timestamp && (!acc.firstTs || turn.timestamp < acc.firstTs)) acc.firstTs = turn.timestamp
          if (turn.timestamp && turn.timestamp > acc.lastTs) acc.lastTs = turn.timestamp
        }
      }
    }
  }

  const sessionFiles = new Set<string>([...activeRowsByFile.keys(), ...loadedAccByFile.keys()])
  const sessions: BreakdownSession[] = []

  for (const sessionFile of sessionFiles) {
    const activeRows = (activeRowsByFile.get(sessionFile) ?? [])
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    const acc = loadedAccByFile.get(sessionFile)
    const turns: BreakdownTurn[] = [...activeRows]
    if (acc) {
      turns.push({
        sessionFile,
        ts: acc.lastTs,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: acc.cacheCreationTokens,
        cacheReadTokens: acc.cacheReadTokens,
        dollars: acc.dollars,
        attribution: 'loaded',
        model: acc.model,
      })
    }
    if (turns.length > 0) sessions.push({ sessionFile, turns })
  }

  sessions.sort((a, b) => {
    const aTs = a.turns.reduce((m, t) => (t.ts > m ? t.ts : m), '')
    const bTs = b.turns.reduce((m, t) => (t.ts > m ? t.ts : m), '')
    return bTs.localeCompare(aTs)
  })

  // `maxTurns` now bounds total rows across sessions (sanity cap only —
  // active rows are bounded by real activation count, loaded is one row per
  // session). Default 100 is virtually never hit.
  let total = 0
  const out: BreakdownSession[] = []
  for (const s of sessions) {
    if (total >= maxTurns) break
    if (total + s.turns.length <= maxTurns) {
      out.push(s)
      total += s.turns.length
    } else {
      out.push({ sessionFile: s.sessionFile, turns: s.turns.slice(0, maxTurns - total) })
      total = maxTurns
    }
  }
  return out
}

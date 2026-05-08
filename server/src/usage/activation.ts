import fs from 'fs'
import path from 'path'
import { findSessionFiles } from './parser'

const MIN_DELTA_TOLERANCE = 200  // tokens — smaller than any plausible skill body
const MATCH_TOLERANCE = 0.15     // ±15% around the delta

export interface SkillTokenInfo {
  name: string
  bodyTokens: number
}

export interface ActivationEvent {
  sessionId: string
  turnIndex: number     // 0-based index of the assistant turn within the session
  timestamp: string
  injectedSkills: string[]
  cacheCreateDelta: number
  unexplainedDelta: number
}

// Normalized turn — harness-agnostic representation consumed by the detector.
export interface SessionTurn {
  timestamp: string
  commandName?: string      // skill name from <command-message> if this is a slash command
  isCompaction: boolean     // assistant turn where context_management is non-null
  isAssistant: boolean      // true for valid assistant turns (including compaction turns)
  cacheCreationTokens: number
  cacheReadTokens: number
}

export interface SessionData {
  sessionId: string
  turns: SessionTurn[]       // sorted by timestamp
}

export interface ActivationDetector {
  detect(sessionData: SessionData, validSkills: SkillTokenInfo[]): ActivationEvent[]
}

function withinTolerance(candidate: number, target: number): boolean {
  if (target === 0) return false
  return Math.abs(candidate - target) / target <= MATCH_TOLERANCE
}

export class ClaudeCodeActivationDetector implements ActivationDetector {
  detect(sessionData: SessionData, validSkills: SkillTokenInfo[]): ActivationEvent[] {
    const events: ActivationEvent[] = []
    const injectedNames = new Set<string>()
    let turnIndex = -1
    let pendingCommandHint: string | undefined

    for (const turn of sessionData.turns) {
      if (turn.isCompaction) {
        injectedNames.clear()
        pendingCommandHint = undefined
        turnIndex++
        continue
      }

      if (!turn.isAssistant) {
        if (turn.commandName) {
          pendingCommandHint = turn.commandName
        }
        continue
      }

      turnIndex++
      const cc = turn.cacheCreationTokens

      if (cc > MIN_DELTA_TOLERANCE) {
        const candidates = validSkills.filter(s => !injectedNames.has(s.name))
        let matched: string[] = []
        let unexplained = cc

        // Try single-skill match first.
        const singleMatches = candidates.filter(s => withinTolerance(s.bodyTokens, cc))
        if (singleMatches.length === 1) {
          matched = [singleMatches[0].name]
          unexplained = 0
        } else if (singleMatches.length > 1) {
          // Ambiguous single — use slash-command hint as tiebreaker.
          const hinted = pendingCommandHint
            ? singleMatches.find(s => s.name === pendingCommandHint)
            : undefined
          matched = hinted ? [hinted.name] : singleMatches.map(s => s.name)
          unexplained = 0
        } else {
          // Pair matching is disabled: spike against real sessions (May 2026) showed
          // 190 pair-matched events vs 98 single-skill events, with repeated false-positive
          // pairs (e.g. context-degradation+gsd-codebase-mapper) lacking slash-command
          // corroboration. Unmatched deltas go to unexplainedDelta until a tighter
          // constraint can be established (Phase 15.1).
        }

        for (const name of matched) {
          injectedNames.add(name)
        }

        events.push({
          sessionId: sessionData.sessionId,
          turnIndex,
          timestamp: turn.timestamp,
          injectedSkills: matched,
          cacheCreateDelta: cc,
          unexplainedDelta: unexplained,
        })
      }

      pendingCommandHint = undefined
    }

    return events
  }
}

const CMD_MSG_RE = /<command-message>([^<]+)<\/command-message>/

function parseSessionFileToSessionData(filePath: string): SessionData {
  const sessionId = path.basename(filePath, '.jsonl')
  const turns: SessionTurn[] = []

  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return { sessionId, turns }
  }

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
    const timestamp = typeof obj['timestamp'] === 'string' ? obj['timestamp'] : ''
    const msg = obj['message'] as Record<string, unknown> | undefined

    if (type === 'user') {
      const content = typeof msg?.['content'] === 'string' ? msg['content'] : ''
      let commandName: string | undefined
      if (content.includes('<command-name>')) {
        const m = content.match(CMD_MSG_RE)
        if (m) commandName = m[1].trim()
      }
      turns.push({ timestamp, commandName, isCompaction: false, isAssistant: false, cacheCreationTokens: 0, cacheReadTokens: 0 })
      continue
    }

    if (type !== 'assistant') continue
    if (!msg || msg['role'] !== 'assistant') continue

    const usage = msg['usage'] as Record<string, unknown> | undefined
    const cc = typeof usage?.['cache_creation_input_tokens'] === 'number' ? usage['cache_creation_input_tokens'] : 0
    const cr = typeof usage?.['cache_read_input_tokens'] === 'number' ? usage['cache_read_input_tokens'] : 0

    const contextMgmt = msg['context_management']
    const isCompaction = contextMgmt != null && contextMgmt !== null

    turns.push({ timestamp, isCompaction, isAssistant: true, cacheCreationTokens: cc, cacheReadTokens: cr })
  }

  // Sort by timestamp (defensive — JSONL lines are usually chronological).
  turns.sort((a, b) => {
    if (!a.timestamp) return -1
    if (!b.timestamp) return 1
    return a.timestamp.localeCompare(b.timestamp)
  })

  return { sessionId, turns }
}

export function detectActivations(
  validSkills: SkillTokenInfo[],
  since?: Date,
): ActivationEvent[] {
  const detector = new ClaudeCodeActivationDetector()
  const allEvents: ActivationEvent[] = []

  for (const filePath of findSessionFiles()) {
    const sessionData = parseSessionFileToSessionData(filePath)
    const events = detector.detect(sessionData, validSkills)
    for (const event of events) {
      if (since && event.timestamp && new Date(event.timestamp) < since) continue
      allEvents.push(event)
    }
  }

  return allEvents.sort((a, b) => {
    const cmp = a.sessionId.localeCompare(b.sessionId)
    return cmp !== 0 ? cmp : a.turnIndex - b.turnIndex
  })
}

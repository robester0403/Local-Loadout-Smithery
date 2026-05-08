import fs from 'fs'
import path from 'path'
import { findSessionFiles } from './parser'

export interface SkillTokenInfo {
  name: string
  bodyTokens: number
}

export interface ActivationEvent {
  sessionId: string
  turnIndex: number     // 0-based index of the assistant turn within the session
  timestamp: string
  injectedSkills: string[]
  // Cache delta on the activating turn — informational only. Not used for
  // attribution: detection is driven by explicit signals, not heuristics.
  cacheCreateDelta: number
}

// Normalized turn — harness-agnostic representation consumed by the detector.
export interface SessionTurn {
  timestamp: string
  // Slash-command name extracted from a <command-message> tag in a user turn.
  // Reliable signal: user explicitly invoked /<name>.
  commandName?: string
  // Skill names invoked from this assistant turn via the Skill tool. Reliable
  // signal: Claude itself triggered the skill (covers transitive activations
  // where one skill instructs Claude to call another).
  skillToolInvocations: string[]
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

// Signal-based activation detection. The cache-delta heuristic was retired
// because it could not distinguish skill-body deltas from system-content,
// post-compaction re-cache, file reads, MCP tool refreshes, or Task-tool
// overhead — producing systematic false-positive Active $ for skills the user
// had never invoked. We now attribute only when we have an explicit ground-truth
// signal that a skill body was injected:
//   1. <command-message> tag in a user turn (slash-command invocation)
//   2. tool_use block with name="Skill" in an assistant turn (Claude calling
//      another skill via the Skill tool, including transitive skill→skill chains)
// Each signal queues the named skill for attribution on the *next* assistant
// turn, where the body actually lands in cache.
export class ClaudeCodeActivationDetector implements ActivationDetector {
  detect(sessionData: SessionData, validSkills: SkillTokenInfo[]): ActivationEvent[] {
    const validSet = new Set(validSkills.map(s => s.name))
    const events: ActivationEvent[] = []
    const injectedNames = new Set<string>()
    const pendingSignals: string[] = []
    let turnIndex = -1

    for (const turn of sessionData.turns) {
      if (turn.isCompaction) {
        // Cache is wiped — anything previously in context will need to be
        // re-injected via a fresh signal to count again.
        injectedNames.clear()
        pendingSignals.length = 0
        turnIndex++
        continue
      }

      if (!turn.isAssistant) {
        if (turn.commandName) pendingSignals.push(turn.commandName)
        continue
      }

      turnIndex++

      const activated: string[] = []
      for (const name of pendingSignals) {
        if (!validSet.has(name)) continue
        if (injectedNames.has(name)) continue
        activated.push(name)
        injectedNames.add(name)
      }
      pendingSignals.length = 0

      if (activated.length > 0) {
        events.push({
          sessionId: sessionData.sessionId,
          turnIndex,
          timestamp: turn.timestamp,
          injectedSkills: activated,
          cacheCreateDelta: turn.cacheCreationTokens,
        })
      }

      // Skill tool calls in this assistant turn cause the named skills to be
      // injected into the cache by the next assistant turn — queue for then.
      for (const name of turn.skillToolInvocations) {
        pendingSignals.push(name)
      }
    }

    return events
  }
}

const CMD_MSG_RE = /<command-message>([^<]+)<\/command-message>/

function extractSkillToolInvocations(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (b['type'] !== 'tool_use') continue
    if (b['name'] !== 'Skill') continue
    const input = b['input'] as Record<string, unknown> | undefined
    const skill = input?.['skill']
    if (typeof skill === 'string' && skill.length > 0) out.push(skill)
  }
  return out
}

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
      turns.push({
        timestamp, commandName, skillToolInvocations: [],
        isCompaction: false, isAssistant: false,
        cacheCreationTokens: 0, cacheReadTokens: 0,
      })
      continue
    }

    if (type !== 'assistant') continue
    if (!msg || msg['role'] !== 'assistant') continue

    const usage = msg['usage'] as Record<string, unknown> | undefined
    const cc = typeof usage?.['cache_creation_input_tokens'] === 'number' ? (usage['cache_creation_input_tokens'] as number) : 0
    const cr = typeof usage?.['cache_read_input_tokens'] === 'number' ? (usage['cache_read_input_tokens'] as number) : 0

    const contextMgmt = msg['context_management']
    const isCompaction = contextMgmt != null && contextMgmt !== null

    const skillToolInvocations = extractSkillToolInvocations(msg['content'])

    turns.push({
      timestamp, skillToolInvocations,
      isCompaction, isAssistant: true,
      cacheCreationTokens: cc, cacheReadTokens: cr,
    })
  }

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

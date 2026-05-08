import fs from 'fs'
import { findSessionFiles, extractToolUses } from '../usage/parser'
import { getPricing, toDollars } from '../usage/pricing'
import { discoverAllSkills } from '../scanner'
import { MCP_RE } from './sessionInjected'

export interface MCPToolUsage {
  name: string
  calls: number
  lastInvoked: string
}

export interface MCPUsageSummary {
  serverName: string
  invocations: number
  lastInvoked: string
  tokens: number
  dollars: number
  tools: MCPToolUsage[]
}

export interface MCPRelationship {
  skillName: string
  serverName: string
  calls: number
}

const CMD_MSG_RE = /<command-message>([^<]+)<\/command-message>/

interface TurnInfo {
  ts: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  mcpToolNames: string[]
  currentSkill: string | null
}

function walkMCPSessions(
  since: Date | undefined,
  validSkills: Set<string>,
  onAssistantTurn: (turn: TurnInfo) => void,
): void {
  for (const file of findSessionFiles()) {
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf-8')
    } catch {
      continue
    }

    let currentSkill: string | null = null

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

      if (type === 'user') {
        const content = (obj['message'] as Record<string, unknown> | undefined)?.['content']
        if (typeof content === 'string' && content.includes('<command-name>')) {
          const nameMatch = content.match(CMD_MSG_RE)
          if (nameMatch) {
            const name = nameMatch[1].trim()
            currentSkill = validSkills.has(name) ? name : null
          }
        }
        continue
      }

      if (type !== 'assistant') continue
      const msg = obj['message'] as Record<string, unknown> | undefined
      if (!msg || msg['role'] !== 'assistant') continue
      const usageRaw = msg['usage'] as Record<string, unknown> | undefined
      if (!usageRaw) continue

      const ts = typeof obj['timestamp'] === 'string' ? obj['timestamp'] : ''
      if (since && ts && new Date(ts) < since) continue

      const model = typeof msg['model'] === 'string' ? msg['model'] : ''
      const content = Array.isArray(msg['content']) ? (msg['content'] as unknown[]) : []
      const toolUses = extractToolUses(content)

      const mcpToolNames = toolUses.filter(name => {
        MCP_RE.lastIndex = 0
        return MCP_RE.test(name)
      })

      if (mcpToolNames.length === 0) continue

      const inputTokens = typeof usageRaw['input_tokens'] === 'number' ? usageRaw['input_tokens'] : 0
      const outputTokens = typeof usageRaw['output_tokens'] === 'number' ? usageRaw['output_tokens'] : 0
      const cacheCreationTokens = typeof usageRaw['cache_creation_input_tokens'] === 'number' ? usageRaw['cache_creation_input_tokens'] : 0
      const cacheReadTokens = typeof usageRaw['cache_read_input_tokens'] === 'number' ? usageRaw['cache_read_input_tokens'] : 0

      onAssistantTurn({ ts, model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, mcpToolNames, currentSkill })
    }
  }
}

export function computeMCPUsage(since?: Date, validSkills?: Set<string>): MCPUsageSummary[] {
  const skills = validSkills ?? new Set(discoverAllSkills().map(s => s.name))

  interface ServerState {
    invocations: number
    lastInvoked: string
    tokens: number
    dollars: number
    tools: Map<string, { calls: number; lastInvoked: string }>
  }

  const acc = new Map<string, ServerState>()

  walkMCPSessions(since, skills, ({ ts, model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, mcpToolNames }) => {
    const pricing = getPricing(model)
    const dollars = pricing
      ? toDollars(inputTokens, pricing.inputPerM) +
        toDollars(outputTokens, pricing.outputPerM) +
        toDollars(cacheCreationTokens, pricing.cacheWritePerM) +
        toDollars(cacheReadTokens, pricing.cacheReadPerM)
      : 0
    const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens

    // One invocation per server per turn, even if called multiple times
    const serversInTurn = new Set<string>()
    for (const name of mcpToolNames) {
      MCP_RE.lastIndex = 0
      const match = MCP_RE.exec(name)
      if (match) serversInTurn.add(match[1])
    }

    for (const serverName of serversInTurn) {
      if (!acc.has(serverName)) {
        acc.set(serverName, { invocations: 0, lastInvoked: '', tokens: 0, dollars: 0, tools: new Map() })
      }
      const entry = acc.get(serverName)!
      entry.invocations++
      if (!entry.lastInvoked || ts > entry.lastInvoked) entry.lastInvoked = ts
      entry.tokens += totalTokens
      entry.dollars += dollars
    }

    // Per-tool call count (each individual tool_use block)
    for (const name of mcpToolNames) {
      MCP_RE.lastIndex = 0
      const match = MCP_RE.exec(name)
      if (!match) continue
      const serverName = match[1]
      const toolName = match[2]
      const entry = acc.get(serverName)!
      const toolState = entry.tools.get(toolName) ?? { calls: 0, lastInvoked: '' }
      toolState.calls++
      if (!toolState.lastInvoked || ts > toolState.lastInvoked) toolState.lastInvoked = ts
      entry.tools.set(toolName, toolState)
    }
  })

  return Array.from(acc.entries())
    .map(([serverName, state]) => ({
      serverName,
      invocations: state.invocations,
      lastInvoked: state.lastInvoked,
      tokens: state.tokens,
      dollars: state.dollars,
      tools: Array.from(state.tools.entries())
        .map(([name, t]) => ({ name, calls: t.calls, lastInvoked: t.lastInvoked }))
        .sort((a, b) => b.calls - a.calls),
    }))
    .sort((a, b) => b.dollars - a.dollars)
}

export function computeMCPRelationships(since?: Date, validSkills?: Set<string>): MCPRelationship[] {
  const skills = validSkills ?? new Set(discoverAllSkills().map(s => s.name))
  const acc = new Map<string, Map<string, number>>()

  walkMCPSessions(since, skills, ({ mcpToolNames, currentSkill }) => {
    if (!currentSkill) return

    const serversInTurn = new Set<string>()
    for (const name of mcpToolNames) {
      MCP_RE.lastIndex = 0
      const match = MCP_RE.exec(name)
      if (match) serversInTurn.add(match[1])
    }

    for (const serverName of serversInTurn) {
      if (!acc.has(currentSkill)) acc.set(currentSkill, new Map())
      const skillMap = acc.get(currentSkill)!
      skillMap.set(serverName, (skillMap.get(serverName) ?? 0) + 1)
    }
  })

  const result: MCPRelationship[] = []
  for (const [skillName, servers] of acc.entries()) {
    for (const [serverName, calls] of servers.entries()) {
      result.push({ skillName, serverName, calls })
    }
  }
  return result.sort((a, b) => b.calls - a.calls)
}

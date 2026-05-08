import fs from 'fs'
import { findSessionFiles } from '../usage/parser'

// Matches mcp__<server>__<tool> — server/tool names may contain hyphens and underscores
export const MCP_RE = /mcp__([a-zA-Z0-9_][a-zA-Z0-9_-]*)__([a-zA-Z0-9_][a-zA-Z0-9_-]*)/g

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export interface SessionInjectedServer {
  name: string
  tools: string[]
}

export function detectSessionInjected(
  configuredNames: Set<string>,
): SessionInjectedServer[] {
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS)
  const serverTools = new Map<string, Set<string>>()

  for (const file of findSessionFiles()) {
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf-8')
    } catch {
      continue
    }

    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue

      // Filter by timestamp to stay within the 30-day window
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        continue
      }
      const ts = typeof obj['timestamp'] === 'string' ? obj['timestamp'] : ''
      if (ts && new Date(ts) < cutoff) continue

      // Scan raw JSON text for mcp__ patterns (handles all turn types)
      MCP_RE.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = MCP_RE.exec(trimmed)) !== null) {
        const serverName = match[1]
        const toolName = match[2]
        if (!configuredNames.has(serverName)) {
          if (!serverTools.has(serverName)) serverTools.set(serverName, new Set())
          serverTools.get(serverName)!.add(toolName)
        }
      }
    }
  }

  return Array.from(serverTools.entries())
    .map(([name, toolSet]) => ({ name, tools: Array.from(toolSet).sort() }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

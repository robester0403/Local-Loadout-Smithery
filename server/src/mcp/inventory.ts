import { discoverMCPServers } from './discover'
import { probeMCPStdio } from './stdioClient'
import { loadCached, saveCache } from './cache'
import { detectSessionInjected } from './sessionInjected'
import type { MCPServerEntry, MCPTool } from './types'

async function probeServer(
  name: string,
  type: 'stdio' | 'sse' | 'http',
  command: string | undefined,
  args: string[],
  env: Record<string, string>,
  configHash: string,
  skipCache: boolean,
): Promise<{ tools: MCPTool[]; status: 'ok' | 'unavailable' | 'unknown'; statusReason?: string }> {
  if (!skipCache) {
    const cached = loadCached(name, configHash)
    if (cached) return cached
  }

  if (type === 'stdio' && command) {
    const result = await probeMCPStdio(command, args, env)
    if (result.status === 'ok') {
      saveCache(name, configHash, 'ok', result.tools)
      return { tools: result.tools, status: 'ok' }
    }
    saveCache(name, configHash, 'unavailable', [], result.reason)
    return { tools: [], status: 'unavailable', statusReason: result.reason }
  }

  // SSE/HTTP transport deferred (P13.3)
  return {
    tools: [],
    status: 'unknown',
    statusReason: `${type.toUpperCase()} transport not yet supported`,
  }
}

export async function buildMCPInventory(skipCache = false): Promise<MCPServerEntry[]> {
  const configured = discoverMCPServers()
  const configuredNames = new Set(configured.map((s) => s.name))
  const entries: MCPServerEntry[] = []

  // Probe configured servers in parallel
  const results = await Promise.all(
    configured.map(async (server) => {
      const probe = await probeServer(
        server.name,
        server.type,
        server.command,
        server.args ?? [],
        server.env ?? {},
        server.configHash,
        skipCache,
      )
      const entry: MCPServerEntry = {
        name: server.name,
        kind: 'configured',
        scope: server.scope,
        transport: server.type,
        tools: probe.tools,
        schemaBytes:
          probe.status === 'ok'
            ? probe.tools.reduce((sum, t) => sum + t.schemaBytes, 0)
            : null,
        status: probe.status,
        statusReason: probe.statusReason,
        source: server.source,
        projectPath: server.projectPath,
      }
      return entry
    }),
  )
  entries.push(...results)

  // Session-injected: servers seen in transcripts but not in config
  const injected = detectSessionInjected(configuredNames)
  for (const inj of injected) {
    entries.push({
      name: inj.name,
      kind: 'session-injected',
      tools: inj.tools.map((toolName) => ({ name: toolName, schemaBytes: 0 })),
      schemaBytes: null,
      status: 'unknown',
      statusReason: 'Bridged from claude.ai — schema not retrievable',
    })
  }

  // Configured servers first, then session-injected; within each group, alphabetical
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'configured' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return entries
}

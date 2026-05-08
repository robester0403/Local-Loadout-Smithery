import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import type { MCPServer } from './types'

function hashConfig(obj: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16)
}

function parseMcpEntry(
  name: string,
  entry: Record<string, unknown>,
  scope: 'global' | 'project',
  source: string,
  projectPath?: string,
): MCPServer {
  const rawType = entry['type']
  const type: 'stdio' | 'sse' | 'http' =
    rawType === 'sse' ? 'sse' : rawType === 'http' ? 'http' : 'stdio'
  return {
    name,
    scope,
    projectPath,
    type,
    command: typeof entry['command'] === 'string' ? entry['command'] : undefined,
    args: Array.isArray(entry['args']) ? (entry['args'] as string[]) : [],
    env:
      entry['env'] !== null && typeof entry['env'] === 'object'
        ? (entry['env'] as Record<string, string>)
        : {},
    url: typeof entry['url'] === 'string' ? entry['url'] : undefined,
    source,
    configHash: hashConfig({
      command: entry['command'],
      args: entry['args'],
      env: entry['env'],
      url: entry['url'],
    }),
  }
}

export function discoverMCPServers(): MCPServer[] {
  const home = os.homedir()
  const servers: MCPServer[] = []

  // Global: ~/.claude.json
  const globalConfig = path.join(home, '.claude.json')
  try {
    const raw = fs.readFileSync(globalConfig, 'utf-8')
    const cfg = JSON.parse(raw) as Record<string, unknown>
    const mcpServers = cfg['mcpServers'] as Record<string, Record<string, unknown>> | undefined
    if (mcpServers && typeof mcpServers === 'object') {
      for (const [name, entry] of Object.entries(mcpServers)) {
        if (entry && typeof entry === 'object') {
          servers.push(parseMcpEntry(name, entry, 'global', globalConfig))
        }
      }
    }
  } catch {
    /* no global config */
  }

  // Project-scoped: ~/.claude/projects/*/.mcp.json
  const projectsDir = path.join(home, '.claude', 'projects')
  try {
    for (const projectHash of fs.readdirSync(projectsDir)) {
      const mcpFile = path.join(projectsDir, projectHash, '.mcp.json')
      if (!fs.existsSync(mcpFile)) continue
      try {
        const raw = fs.readFileSync(mcpFile, 'utf-8')
        const cfg = JSON.parse(raw) as Record<string, unknown>
        const mcpServers = cfg['mcpServers'] as
          | Record<string, Record<string, unknown>>
          | undefined
        if (mcpServers && typeof mcpServers === 'object') {
          for (const [name, entry] of Object.entries(mcpServers)) {
            if (entry && typeof entry === 'object') {
              servers.push(parseMcpEntry(name, entry, 'project', mcpFile, projectHash))
            }
          }
        }
      } catch {
        /* skip malformed file */
      }
    }
  } catch {
    /* no projects dir */
  }

  return servers
}

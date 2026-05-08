import fs from 'fs'
import os from 'os'
import path from 'path'
import type { MCPTool } from './types'

const OK_MAX_AGE_MS = 24 * 60 * 60 * 1000
// Unavailable results expire faster — docker might not have been running
const UNAVAILABLE_MAX_AGE_MS = 5 * 60 * 1000

interface CacheEntry {
  configHash: string
  fetchedAt: string
  status: 'ok' | 'unavailable'
  tools: MCPTool[]
  statusReason?: string
}

interface CacheFile {
  entries: Record<string, CacheEntry>
}

export interface CachedProbeResult {
  status: 'ok' | 'unavailable'
  tools: MCPTool[]
  statusReason?: string
}

function cacheFilePath(): string {
  return path.join(os.homedir(), '.loadoutsmith', 'mcp-cache.json')
}

function loadFile(): CacheFile {
  try {
    const raw = fs.readFileSync(cacheFilePath(), 'utf-8')
    return JSON.parse(raw) as CacheFile
  } catch {
    return { entries: {} }
  }
}

function saveFile(cache: CacheFile): void {
  const file = cacheFilePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf-8')
  fs.renameSync(tmp, file)
}

export function loadCached(serverName: string, configHash: string): CachedProbeResult | null {
  const cache = loadFile()
  const entry = cache.entries[serverName]
  if (!entry) return null
  if (entry.configHash !== configHash) return null
  const ageMs = Date.now() - new Date(entry.fetchedAt).getTime()
  const maxAge = entry.status === 'ok' ? OK_MAX_AGE_MS : UNAVAILABLE_MAX_AGE_MS
  if (ageMs > maxAge) return null
  return { status: entry.status, tools: entry.tools, statusReason: entry.statusReason }
}

export function saveCache(
  serverName: string,
  configHash: string,
  status: 'ok' | 'unavailable',
  tools: MCPTool[],
  statusReason?: string,
): void {
  const cache = loadFile()
  cache.entries[serverName] = {
    configHash,
    fetchedAt: new Date().toISOString(),
    status,
    tools,
    statusReason,
  }
  saveFile(cache)
}

export function clearCache(): void {
  saveFile({ entries: {} })
}

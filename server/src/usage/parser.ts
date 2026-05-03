import fs from 'fs'
import os from 'os'
import path from 'path'
import type { UsageTurn, ParseWarning } from './types'

function listDir(dir: string): string[] {
  try { return fs.readdirSync(dir) } catch { return [] }
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

export function findSessionFiles(): string[] {
  const home = os.homedir()
  const files: string[] = []

  for (const entry of listDir(home)) {
    if (!entry.startsWith('.claude')) continue
    const accountDir = path.join(home, entry)
    if (!isDir(accountDir)) continue

    const projectsDir = path.join(accountDir, 'projects')
    for (const projectHash of listDir(projectsDir)) {
      const projectDir = path.join(projectsDir, projectHash)
      if (!isDir(projectDir)) continue

      for (const file of listDir(projectDir)) {
        // Only top-level UUID session files — skip subagent dirs
        if (file.endsWith('.jsonl')) {
          files.push(path.join(projectDir, file))
        }
      }
    }
  }

  return files
}

function extractToolUses(content: unknown[]): string[] {
  const names: string[] = []
  for (const block of content) {
    if (
      block != null &&
      typeof block === 'object' &&
      (block as Record<string, unknown>)['type'] === 'tool_use'
    ) {
      const name = (block as Record<string, unknown>)['name']
      if (typeof name === 'string') names.push(name)
    }
  }
  return names
}

export function parseSessionFile(
  filePath: string,
  warnings: ParseWarning[],
): UsageTurn[] {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    warnings.push({ file: filePath, line: 0, reason: 'Could not read file' })
    return []
  }

  const turns: UsageTurn[] = []
  const lines = raw.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      warnings.push({ file: filePath, line: i + 1, reason: 'Invalid JSON' })
      continue
    }

    // Only process assistant turns with usage data
    if (obj['type'] !== 'assistant') continue

    const msg = obj['message']
    if (msg == null || typeof msg !== 'object') continue
    const message = msg as Record<string, unknown>

    if (message['role'] !== 'assistant') continue

    const usageRaw = message['usage']
    if (usageRaw == null || typeof usageRaw !== 'object') continue
    const usage = usageRaw as Record<string, unknown>

    const model = message['model']
    if (typeof model !== 'string') {
      warnings.push({ file: filePath, line: i + 1, reason: 'Missing model field' })
      continue
    }

    const timestamp = obj['timestamp']
    const sessionId = obj['sessionId']
    const cwd = obj['cwd']

    const inputTokens = typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0
    const outputTokens = typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0
    const cacheCreationTokens =
      typeof usage['cache_creation_input_tokens'] === 'number'
        ? usage['cache_creation_input_tokens']
        : 0
    const cacheReadTokens =
      typeof usage['cache_read_input_tokens'] === 'number'
        ? usage['cache_read_input_tokens']
        : 0

    const content = Array.isArray(message['content']) ? message['content'] as unknown[] : []
    const toolUses = extractToolUses(content)

    turns.push({
      timestamp: typeof timestamp === 'string' ? timestamp : '',
      sessionId: typeof sessionId === 'string' ? sessionId : '',
      cwd: typeof cwd === 'string' ? cwd : '',
      model,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      toolUses,
    })
  }

  return turns
}

export function parseAllSessions(): { turns: UsageTurn[]; warnings: ParseWarning[] } {
  const warnings: ParseWarning[] = []
  const turns: UsageTurn[] = []

  for (const file of findSessionFiles()) {
    turns.push(...parseSessionFile(file, warnings))
  }

  return { turns, warnings }
}

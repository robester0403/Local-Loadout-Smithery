import fs from 'fs'
import path from 'path'
import { discoverAllSkills } from '../scanner'
import { findSessionFiles } from './parser'
import { getPricing, toDollars } from './pricing'
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

const CMD_MSG_RE = /<command-message>([^<]+)<\/command-message>/

export function breakdownForSkill(
  skillName: string,
  skillBody: string,
  skillType: SkillType,
  maxTurns = 100,
): BreakdownSession[] {
  const allSkills = discoverAllSkills()
  const nonCommandSkills = allSkills
    .filter(s => s.type !== 'command')
    .map(s => ({ name: s.name, bodyBytes: Buffer.byteLength(s.body ?? '', 'utf-8') }))
    .filter(s => s.bodyBytes > 0)

  const totalBytes = nonCommandSkills.reduce((sum, s) => sum + s.bodyBytes, 0)
  const skillBodyBytes = Buffer.byteLength(skillBody ?? '', 'utf-8')
  const loadedShare = totalBytes > 0 ? skillBodyBytes / totalBytes : 0

  const validSkills = new Set(allSkills.map(s => s.name))

  const allMatchingTurns: BreakdownTurn[] = []
  const sessionFiles = findSessionFiles()

  for (const filePath of sessionFiles) {
    let raw: string
    try {
      raw = fs.readFileSync(filePath, 'utf-8')
    } catch {
      continue
    }

    const sessionFile = path.basename(filePath, '.jsonl')
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

      // Track active skill via command-message tags
      if (type === 'user') {
        const content = (obj['message'] as Record<string, unknown> | undefined)?.['content']
        if (typeof content === 'string' && content.includes('<command-name>')) {
          const nameMatch = content.match(CMD_MSG_RE)
          if (nameMatch) {
            const name = nameMatch[1].trim()
            if (validSkills.has(name)) {
              currentSkill = name
            } else {
              currentSkill = null
            }
          }
        }
        continue
      }

      if (type !== 'assistant') continue
      const msg = obj['message'] as Record<string, unknown> | undefined
      if (!msg || msg['role'] !== 'assistant') continue
      const usage = msg['usage'] as Record<string, unknown> | undefined
      if (!usage) continue

      const input = typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0
      const output = typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0
      const cacheCreate =
        typeof usage['cache_creation_input_tokens'] === 'number'
          ? usage['cache_creation_input_tokens']
          : 0
      const cacheRead =
        typeof usage['cache_read_input_tokens'] === 'number'
          ? usage['cache_read_input_tokens']
          : 0

      const model = typeof msg['model'] === 'string' ? msg['model'] : ''
      const pricing = getPricing(model)
      const ts = typeof obj['timestamp'] === 'string' ? obj['timestamp'] : ''

      // Active attribution
      if (currentSkill === skillName) {
        const dollars = pricing
          ? toDollars(input, pricing.inputPerM) +
            toDollars(output, pricing.outputPerM) +
            toDollars(cacheCreate, pricing.cacheWritePerM) +
            toDollars(cacheRead, pricing.cacheReadPerM)
          : 0

        allMatchingTurns.push({
          sessionFile,
          ts,
          inputTokens: input,
          outputTokens: output,
          cacheCreationTokens: cacheCreate,
          cacheReadTokens: cacheRead,
          dollars,
          attribution: 'active',
          model,
        })
        continue
      }

      // Loaded attribution — only for non-command skills
      if (skillType !== 'command' && (input > 0 || cacheCreate > 0 || cacheRead > 0)) {
        const dollars = pricing
          ? toDollars(input * loadedShare, pricing.inputPerM) +
            toDollars(cacheCreate * loadedShare, pricing.cacheWritePerM) +
            toDollars(cacheRead * loadedShare, pricing.cacheReadPerM)
          : 0

        // Skip negligible loaded turns
        if (dollars < 0.000001) continue

        allMatchingTurns.push({
          sessionFile,
          ts,
          inputTokens: Math.round(input * loadedShare),
          outputTokens: 0,
          cacheCreationTokens: Math.round(cacheCreate * loadedShare),
          cacheReadTokens: Math.round(cacheRead * loadedShare),
          dollars,
          attribution: 'loaded',
          model,
        })
      }
    }
  }

  // Sort by dollars descending and cap
  allMatchingTurns.sort((a, b) => b.dollars - a.dollars)
  const capped = allMatchingTurns.slice(0, maxTurns)

  // Group by session
  const sessionMap = new Map<string, BreakdownTurn[]>()
  for (const turn of capped) {
    if (!sessionMap.has(turn.sessionFile)) {
      sessionMap.set(turn.sessionFile, [])
    }
    sessionMap.get(turn.sessionFile)!.push(turn)
  }

  return Array.from(sessionMap.entries()).map(([sessionFile, turns]) => ({
    sessionFile,
    turns,
  }))
}

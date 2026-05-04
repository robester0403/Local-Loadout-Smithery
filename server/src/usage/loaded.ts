import fs from 'fs'
import { getPricing, toDollars } from './pricing'
import { findSessionFiles } from './parser'
import { discoverAllSkills } from '../scanner'
import type { SkillType } from '../scanner/types'

export interface LoadedCostEntry {
  skillName: string
  // bytes of name+description metadata (the portion always in context)
  bodyBytes: number
  loadedTurns: number
  inputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalDollars: number
}

export interface LoadedSkillInput {
  name: string
  description?: string
  // Commands have no loaded cost — only injected when the user types /foo.
  // Skills + subagents share the loaded tax. Omit to default to "included."
  type?: SkillType
}

interface PreparedSkill {
  name: string
  bodyBytes: number
}

function processSession(
  filePath: string,
  loaded: PreparedSkill[],
  totalBytes: number,
  acc: Map<string, LoadedCostEntry>,
): void {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return
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

    if (obj['type'] !== 'assistant') continue
    const msg = obj['message'] as Record<string, unknown> | undefined
    if (!msg || msg['role'] !== 'assistant') continue
    const usage = msg['usage'] as Record<string, unknown> | undefined
    if (!usage) continue

    const model = typeof msg['model'] === 'string' ? msg['model'] : ''
    const pricing = getPricing(model)

    const input = typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0
    const cacheCreate =
      typeof usage['cache_creation_input_tokens'] === 'number'
        ? usage['cache_creation_input_tokens']
        : 0
    const cacheRead =
      typeof usage['cache_read_input_tokens'] === 'number'
        ? usage['cache_read_input_tokens']
        : 0

    // Nothing on the input side — no context tax to attribute this turn
    if (input === 0 && cacheCreate === 0 && cacheRead === 0) continue

    for (const sk of loaded) {
      const share = sk.bodyBytes / totalBytes
      const skInput = input * share
      const skCacheCreate = cacheCreate * share
      const skCacheRead = cacheRead * share

      const dollars = pricing
        ? toDollars(skInput, pricing.inputPerM) +
          toDollars(skCacheCreate, pricing.cacheWritePerM) +
          toDollars(skCacheRead, pricing.cacheReadPerM)
        : 0

      let entry = acc.get(sk.name)
      if (!entry) {
        entry = {
          skillName: sk.name,
          bodyBytes: sk.bodyBytes,
          loadedTurns: 0,
          inputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalDollars: 0,
        }
        acc.set(sk.name, entry)
      }
      entry.loadedTurns++
      entry.inputTokens += skInput
      entry.cacheCreationTokens += skCacheCreate
      entry.cacheReadTokens += skCacheRead
      entry.totalDollars += dollars
    }
  }
}

export function computeLoadedCost(skills?: LoadedSkillInput[]): LoadedCostEntry[] {
  const list =
    skills ?? discoverAllSkills().map(s => ({ name: s.name, description: s.description, type: s.type }))

  const prepared: PreparedSkill[] = list
    .filter(s => s.type !== 'command')
    .map(s => ({
      name: s.name,
      bodyBytes: Buffer.byteLength(`${s.name} ${s.description ?? ''}`, 'utf-8'),
    }))
    .filter(s => s.bodyBytes > 0)

  if (prepared.length === 0) return []

  const totalBytes = prepared.reduce((sum, s) => sum + s.bodyBytes, 0)
  if (totalBytes === 0) return []

  const acc = new Map<string, LoadedCostEntry>()
  for (const file of findSessionFiles()) {
    processSession(file, prepared, totalBytes, acc)
  }
  return Array.from(acc.values()).sort((a, b) => b.totalDollars - a.totalDollars)
}

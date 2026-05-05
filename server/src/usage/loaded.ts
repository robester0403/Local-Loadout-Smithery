import fs from 'fs'
import { getPricing, toDollars } from './pricing'
import { findSessionFiles } from './parser'
import { discoverAllSkills } from '../scanner'
import type { SkillType } from '../scanner/types'

// Claude Code caps the skill listing per docs: each skill's description is
// truncated at 1536 chars, and the total listing budget defaults to 8000 chars
// (1% of context window, fallback 8000). Names are always included in full.
// See https://code.claude.com/docs/en/skills
export const PER_SKILL_DESC_CAP_BYTES = 1536
export const LISTING_BUDGET_BYTES = 8000
export const BYTES_PER_TOKEN = 4

export interface LoadedCostEntry {
  skillName: string
  // bytes of name+description metadata after caps (the portion actually in context)
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

// Bytes the skill contributes to the listing: name (uncapped) + space + capped description.
// Mirrors the `${name} ${description}` template Claude Code renders.
export function listingBytesFor(name: string, description?: string): number {
  const nameBytes = Buffer.byteLength(name, 'utf-8')
  if (nameBytes === 0) return 0
  const descBytes = Math.min(
    Buffer.byteLength(description ?? '', 'utf-8'),
    PER_SKILL_DESC_CAP_BYTES,
  )
  return nameBytes + 1 + descBytes
}

function processSession(
  filePath: string,
  loaded: PreparedSkill[],
  effectiveScale: number,
  acc: Map<string, LoadedCostEntry>,
  since?: Date,
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

    if (since) {
      const ts = typeof obj['timestamp'] === 'string' ? obj['timestamp'] : ''
      if (ts && new Date(ts) < since) continue
    }
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
    const totalBilled = input + cacheCreate + cacheRead
    if (totalBilled === 0) continue

    for (const sk of loaded) {
      // Tokens this skill contributes to the listing after caps + budget scaling.
      const skTokens = (sk.bodyBytes * effectiveScale) / BYTES_PER_TOKEN
      // Fraction of the turn's billed tokens attributable to this skill's listing slot.
      const share = Math.min(skTokens / totalBilled, 1)
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

export function computeLoadedCost(skills?: LoadedSkillInput[], since?: Date): LoadedCostEntry[] {
  const list =
    skills ?? discoverAllSkills().map(s => ({ name: s.name, description: s.description, type: s.type }))

  const prepared: PreparedSkill[] = list
    .filter(s => s.type !== 'command')
    .map(s => ({
      name: s.name,
      bodyBytes: listingBytesFor(s.name, s.description),
    }))
    .filter(s => s.bodyBytes > 0)

  if (prepared.length === 0) return []

  const rawTotalBytes = prepared.reduce((sum, s) => sum + s.bodyBytes, 0)
  if (rawTotalBytes === 0) return []

  // If raw listing exceeds the budget, descriptions get truncated proportionally.
  const effectiveScale = Math.min(1, LISTING_BUDGET_BYTES / rawTotalBytes)

  const acc = new Map<string, LoadedCostEntry>()
  for (const file of findSessionFiles()) {
    processSession(file, prepared, effectiveScale, acc, since)
  }
  return Array.from(acc.values()).sort((a, b) => b.totalDollars - a.totalDollars)
}

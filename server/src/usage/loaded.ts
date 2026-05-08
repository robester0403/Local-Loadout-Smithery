import fs from 'fs'
import { getPricing, toDollars } from './pricing'
import { findSessionFiles } from './parser'
import { discoverAllSkills } from '../scanner'
import { countTokens } from './tokenizer'
import type { SkillType } from '../scanner/types'

// Claude Code caps the skill listing per docs: each skill's description is
// truncated at 1536 chars, and the total listing budget defaults to 8000 chars
// (1% of context window, fallback 8000). Names are always included in full.
export const PER_SKILL_DESC_CAP_BYTES = 1536
export const LISTING_BUDGET_BYTES = 8000

export interface LoadedCostEntry {
  skillName: string
  listingBytes: number
  listingTokens: number
  loadedTurns: number
  cacheCreationTokens: number  // listing tokens charged at cache_create rate (first turn of session)
  cacheReadTokens: number      // listing tokens charged at cache_read rate (subsequent turns)
  totalDollars: number
}

export interface LoadedSkillInput {
  name: string
  description?: string
  type?: SkillType
  // Pre-computed token count from scanner; if absent we compute it here.
  listingTokens?: number
  listingBytes?: number
}

interface PreparedSkill {
  name: string
  listingBytes: number
  listingTokens: number
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

export function listingTokensFor(name: string, description?: string): number {
  const truncated = (description ?? '').slice(0, PER_SKILL_DESC_CAP_BYTES)
  return countTokens(`${name} ${truncated}`.trimEnd())
}

function prepareSkills(inputs: LoadedSkillInput[]): PreparedSkill[] {
  return inputs
    .filter(s => s.type !== 'command')
    .map(s => ({
      name: s.name,
      listingBytes: s.listingBytes ?? listingBytesFor(s.name, s.description),
      listingTokens: s.listingTokens ?? listingTokensFor(s.name, s.description),
    }))
    .filter(s => s.listingBytes > 0)
}

function processSession(
  filePath: string,
  prepared: PreparedSkill[],
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

  const seenSessionIds = new Set<string>()

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

    // Determine cache state: first qualifying turn of a session → cache_create.
    const sessionId = typeof obj['sessionId'] === 'string' ? obj['sessionId'] : ''
    const isFirstTurn = !seenSessionIds.has(sessionId)
    if (sessionId) seenSessionIds.add(sessionId)

    const model = typeof msg['model'] === 'string' ? msg['model'] : ''
    const pricing = getPricing(model)

    for (const sk of prepared) {
      const effectiveTokens = sk.listingTokens * effectiveScale

      const dollars = pricing
        ? isFirstTurn
          ? toDollars(effectiveTokens, pricing.cacheWritePerM)
          : toDollars(effectiveTokens, pricing.cacheReadPerM)
        : 0

      let entry = acc.get(sk.name)
      if (!entry) {
        entry = {
          skillName: sk.name,
          listingBytes: sk.listingBytes,
          listingTokens: sk.listingTokens,
          loadedTurns: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalDollars: 0,
        }
        acc.set(sk.name, entry)
      }
      entry.loadedTurns++
      if (isFirstTurn) {
        entry.cacheCreationTokens += effectiveTokens
      } else {
        entry.cacheReadTokens += effectiveTokens
      }
      entry.totalDollars += dollars
    }
  }
}

export function computeLoadedCost(skills?: LoadedSkillInput[], since?: Date): LoadedCostEntry[] {
  const list =
    skills ??
    discoverAllSkills().map(s => ({
      name: s.name,
      description: s.description,
      type: s.type,
      listingBytes: s.listingBytes,
      listingTokens: s.listingTokens,
    }))

  const prepared = prepareSkills(list)
  if (prepared.length === 0) return []

  const rawTotalBytes = prepared.reduce((sum, s) => sum + s.listingBytes, 0)
  if (rawTotalBytes === 0) return []

  const effectiveScale = Math.min(1, LISTING_BUDGET_BYTES / rawTotalBytes)

  const acc = new Map<string, LoadedCostEntry>()
  for (const file of findSessionFiles()) {
    processSession(file, prepared, effectiveScale, acc, since)
  }
  return Array.from(acc.values()).sort((a, b) => b.totalDollars - a.totalDollars)
}

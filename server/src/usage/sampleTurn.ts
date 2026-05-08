import fs from 'fs'
import { discoverAllSkills } from '../scanner'
import { findSessionFiles } from './parser'
import { getPricing } from './pricing'
import { listingBytesFor, listingTokensFor, LISTING_BUDGET_BYTES } from './loaded'

export interface SampleTurnResult {
  skillName: string
  listingTokens: number
  effectiveTokens: number
  isFirstTurn: boolean
  dollars: number
  model: string
  formula: string
}

export function getSampleTurn(since?: Date): SampleTurnResult | null {
  const allSkills = discoverAllSkills()
  const prepared = allSkills
    .filter(s => s.type !== 'command')
    .map(s => ({
      name: s.name,
      listingBytes: listingBytesFor(s.name, s.description),
      listingTokens: listingTokensFor(s.name, s.description),
    }))
    .filter(s => s.listingBytes > 0)

  if (prepared.length === 0) return null

  const rawTotalBytes = prepared.reduce((sum, s) => sum + s.listingBytes, 0)
  const effectiveScale = Math.min(1, LISTING_BUDGET_BYTES / rawTotalBytes)

  const topSkill = prepared.reduce((best, s) => (s.listingTokens > best.listingTokens ? s : best))
  const effectiveTokens = topSkill.listingTokens * effectiveScale

  const seenSessions = new Set<string>()

  for (const filePath of findSessionFiles()) {
    let raw: string
    try {
      raw = fs.readFileSync(filePath, 'utf-8')
    } catch {
      continue
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

      const input = typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0
      const cc = typeof usage['cache_creation_input_tokens'] === 'number' ? usage['cache_creation_input_tokens'] : 0
      const cr = typeof usage['cache_read_input_tokens'] === 'number' ? usage['cache_read_input_tokens'] : 0
      if (input + cc + cr === 0) continue

      if (since) {
        const ts = typeof obj['timestamp'] === 'string' ? obj['timestamp'] : ''
        if (ts && new Date(ts) < since) continue
      }

      const sessionId = typeof obj['sessionId'] === 'string' ? obj['sessionId'] : ''
      const isFirstTurn = !seenSessions.has(sessionId)
      if (sessionId) seenSessions.add(sessionId)

      const model = typeof msg['model'] === 'string' ? msg['model'] : ''
      const pricing = getPricing(model)
      const ratePerM = isFirstTurn ? (pricing?.cacheWritePerM ?? 0) : (pricing?.cacheReadPerM ?? 0)
      const dollars = (effectiveTokens / 1_000_000) * ratePerM

      const rateName = isFirstTurn ? 'cache_write' : 'cache_read'
      const scaleNote = effectiveScale < 1
        ? `× ${effectiveScale.toFixed(3)} budget scale = ${effectiveTokens.toFixed(1)} effective tokens`
        : `(no budget cap)`
      const formula = `${topSkill.listingTokens} listing tokens ${scaleNote} · ${rateName} @ $${ratePerM}/M`

      return {
        skillName: topSkill.name,
        listingTokens: topSkill.listingTokens,
        effectiveTokens,
        isFirstTurn,
        dollars,
        model,
        formula,
      }
    }
  }

  return null
}

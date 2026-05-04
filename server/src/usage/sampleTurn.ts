import fs from 'fs'
import path from 'path'
import { discoverAllSkills } from '../scanner'
import { findSessionFiles } from './parser'
import { getPricing, toDollars } from './pricing'

export interface SampleTurnResult {
  skillName: string
  skillBodyBytes: number
  totalBodyBytes: number
  turnInputTokens: number
  turnCacheCreateTokens: number
  turnCacheReadTokens: number
  attributedTokens: number
  dollars: number
  model: string
  formula: string
}

export function getSampleTurn(): SampleTurnResult | null {
  const allSkills = discoverAllSkills()
  const nonCommandSkills = allSkills
    .filter(s => s.type !== 'command')
    .map(s => ({
      name: s.name,
      bodyBytes: Buffer.byteLength(`${s.name} ${s.description ?? ''}`, 'utf-8'),
      description: s.description ?? '',
    }))
    .filter(s => s.bodyBytes > 0)

  if (nonCommandSkills.length === 0) return null

  const totalBodyBytes = nonCommandSkills.reduce((sum, s) => sum + s.bodyBytes, 0)
  if (totalBodyBytes === 0) return null

  const topSkill = nonCommandSkills.reduce((best, s) => (s.bodyBytes > best.bodyBytes ? s : best))

  const sessionFiles = findSessionFiles()

  for (const filePath of sessionFiles) {
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
      const cacheCreate =
        typeof usage['cache_creation_input_tokens'] === 'number'
          ? usage['cache_creation_input_tokens']
          : 0
      const cacheRead =
        typeof usage['cache_read_input_tokens'] === 'number'
          ? usage['cache_read_input_tokens']
          : 0

      if (input === 0 && cacheCreate === 0 && cacheRead === 0) continue

      const model = typeof msg['model'] === 'string' ? msg['model'] : ''
      const pricing = getPricing(model)

      const share = topSkill.bodyBytes / totalBodyBytes
      const totalTurnInputSide = input + cacheCreate + cacheRead
      const attributedTokens = Math.round(totalTurnInputSide * share)

      const dollars = pricing
        ? toDollars(input * share, pricing.inputPerM) +
          toDollars(cacheCreate * share, pricing.cacheWritePerM) +
          toDollars(cacheRead * share, pricing.cacheReadPerM)
        : 0

      const formula =
        `(${topSkill.bodyBytes.toLocaleString()} metadata bytes ÷ ${totalBodyBytes.toLocaleString()} total metadata bytes) × ` +
        `${totalTurnInputSide.toLocaleString()} tokens = ${attributedTokens.toLocaleString()} attributed tokens`

      return {
        skillName: topSkill.name,
        skillBodyBytes: topSkill.bodyBytes,
        totalBodyBytes,
        turnInputTokens: input,
        turnCacheCreateTokens: cacheCreate,
        turnCacheReadTokens: cacheRead,
        attributedTokens,
        dollars,
        model,
        formula,
      }
    }
  }

  return null
}

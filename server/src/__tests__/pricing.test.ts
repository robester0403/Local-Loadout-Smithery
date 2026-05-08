import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getPricing, toDollars, resetPricingCache } from '../usage/pricing'

const PRICING_FILE = path.join(os.homedir(), '.loadoutsmith', 'pricing.json')

beforeEach(() => {
  resetPricingCache()
  try { fs.unlinkSync(PRICING_FILE) } catch { /* not present */ }
})

afterEach(() => {
  resetPricingCache()
  try { fs.unlinkSync(PRICING_FILE) } catch { /* not present */ }
})

describe('getPricing', () => {
  it('returns default rates for known models', () => {
    const p = getPricing('claude-sonnet-4-6')
    expect(p).not.toBeNull()
    expect(p!.inputPerM).toBe(3.00)
    expect(p!.outputPerM).toBe(15.00)
  })

  it('returns null for unknown models', () => {
    expect(getPricing('some-unknown-model')).toBeNull()
  })

  it('prefix-matches versioned model ids', () => {
    const p = getPricing('claude-haiku-4-5-20251001')
    expect(p).not.toBeNull()
    expect(p!.inputPerM).toBe(0.80)
  })

  it('user overrides in pricing.json take precedence', () => {
    fs.mkdirSync(path.dirname(PRICING_FILE), { recursive: true })
    fs.writeFileSync(PRICING_FILE, JSON.stringify({
      models: { 'claude-sonnet-4-6': { inputPerM: 99, outputPerM: 99, cacheWritePerM: 99, cacheReadPerM: 99 } }
    }), 'utf-8')
    resetPricingCache()
    const p = getPricing('claude-sonnet-4-6')
    expect(p!.inputPerM).toBe(99)
  })

  it('falls back to defaults when pricing.json is malformed', () => {
    fs.mkdirSync(path.dirname(PRICING_FILE), { recursive: true })
    fs.writeFileSync(PRICING_FILE, 'not json', 'utf-8')
    resetPricingCache()
    const p = getPricing('claude-sonnet-4-6')
    expect(p!.inputPerM).toBe(3.00)
  })
})

describe('toDollars', () => {
  it('converts tokens to dollars correctly', () => {
    expect(toDollars(1_000_000, 3.00)).toBeCloseTo(3.00)
    expect(toDollars(500_000, 15.00)).toBeCloseTo(7.50)
    expect(toDollars(0, 3.00)).toBe(0)
  })
})

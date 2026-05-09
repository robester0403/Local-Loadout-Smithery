import fs from 'fs'
import path from 'path'
import { LOADOUT_DIR } from '../lib/paths'

export interface ModelPricing {
  inputPerM: number
  outputPerM: number
  cacheWritePerM: number
  cacheReadPerM: number
}

interface PricingFile {
  _note?: string
  _updated?: string
  models: Record<string, ModelPricing>
}

const DEFAULTS: Record<string, ModelPricing> = {
  'claude-opus-4-7':   { inputPerM: 15.00, outputPerM: 75.00, cacheWritePerM: 18.75, cacheReadPerM: 1.50 },
  'claude-opus-4-6':   { inputPerM: 15.00, outputPerM: 75.00, cacheWritePerM: 18.75, cacheReadPerM: 1.50 },
  'claude-sonnet-4-6': { inputPerM:  3.00, outputPerM: 15.00, cacheWritePerM:  3.75, cacheReadPerM: 0.30 },
  'claude-haiku-4-5':  { inputPerM:  0.80, outputPerM:  4.00, cacheWritePerM:  1.00, cacheReadPerM: 0.08 },
  '<synthetic>':       { inputPerM:  0,    outputPerM:  0,    cacheWritePerM:  0,    cacheReadPerM: 0    },
}

const PRICING_FILE = path.join(LOADOUT_DIR, 'pricing.json')

function loadPricingFile(): Record<string, ModelPricing> {
  try {
    const raw = fs.readFileSync(PRICING_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as PricingFile
    if (parsed.models && typeof parsed.models === 'object') return parsed.models
  } catch {
    // file missing or malformed — use defaults
  }
  return {}
}

let _table: Record<string, ModelPricing> | null = null

function getTable(): Record<string, ModelPricing> {
  if (!_table) _table = { ...DEFAULTS, ...loadPricingFile() }
  return _table
}

export function getPricing(model: string): ModelPricing | null {
  const table = getTable()
  if (table[model]) return table[model]
  // Prefix match — e.g. "claude-haiku-4-5-20251001" matches "claude-haiku-4-5"
  for (const key of Object.keys(table)) {
    if (model.startsWith(key)) return table[key]
  }
  return null
}

export function toDollars(tokens: number, ratePerM: number): number {
  return (tokens / 1_000_000) * ratePerM
}

export function writePricingTemplate(): void {
  const dir = LOADOUT_DIR
  fs.mkdirSync(dir, { recursive: true })
  const template: PricingFile = {
    _note: 'Prices in USD per million tokens. Edit to keep current. See https://www.anthropic.com/pricing',
    _updated: new Date().toISOString().slice(0, 10),
    models: DEFAULTS,
  }
  fs.writeFileSync(PRICING_FILE, JSON.stringify(template, null, 2), 'utf-8')
}

export function resetPricingCache(): void {
  _table = null
}

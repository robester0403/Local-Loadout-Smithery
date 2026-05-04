import fs from 'fs'
import { getPricing, toDollars } from './pricing'
import { findSessionFiles } from './parser'
import { discoverAllSkills } from '../scanner'

export interface ActiveCostEntry {
  skillName: string
  invocations: number
  lastInvoked: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalDollars: number
}

const CMD_MSG_RE = /<command-message>([^<]+)<\/command-message>/
const CMD_ARGS_RE = /<command-args>([^<]*)<\/command-args>/

function parseSessionActiveCost(
  filePath: string,
  acc: Map<string, ActiveCostEntry>,
  validSkills: Set<string>,
  since?: Date,
): void {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return
  }

  let currentSkill: string | null = null
  let currentSkillTs: string = ''
  let newInvocation = false

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

    // User turn — check for skill invocation tag
    if (type === 'user') {
      const content = (obj['message'] as Record<string, unknown> | undefined)?.['content']
      if (typeof content === 'string' && content.includes('<command-name>')) {
        const nameMatch = content.match(CMD_MSG_RE)
        if (nameMatch) {
          const name = nameMatch[1].trim()
          if (validSkills.has(name)) {
            currentSkill = name
            currentSkillTs = typeof obj['timestamp'] === 'string' ? obj['timestamp'] : ''
            newInvocation = true
          } else {
            // Built-in or unknown command — stop attributing to any skill
            currentSkill = null
          }
        }
      }
      continue
    }

    // Assistant turn — attribute tokens to current skill
    if (type !== 'assistant') continue
    const msg = obj['message'] as Record<string, unknown> | undefined
    if (!msg || msg['role'] !== 'assistant') continue
    const usage = msg['usage'] as Record<string, unknown> | undefined
    if (!usage) continue
    if (!currentSkill) continue

    if (since) {
      const ts = typeof obj['timestamp'] === 'string' ? obj['timestamp'] : ''
      if (ts && new Date(ts) < since) continue
    }

    const model = typeof msg['model'] === 'string' ? msg['model'] : ''
    const pricing = getPricing(model)

    const input = typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0
    const output = typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0
    const cacheCreate = typeof usage['cache_creation_input_tokens'] === 'number' ? usage['cache_creation_input_tokens'] : 0
    const cacheRead = typeof usage['cache_read_input_tokens'] === 'number' ? usage['cache_read_input_tokens'] : 0

    const dollars = pricing
      ? toDollars(input, pricing.inputPerM) +
        toDollars(output, pricing.outputPerM) +
        toDollars(cacheCreate, pricing.cacheWritePerM) +
        toDollars(cacheRead, pricing.cacheReadPerM)
      : 0

    if (!acc.has(currentSkill)) {
      acc.set(currentSkill, {
        skillName: currentSkill,
        invocations: 0,
        lastInvoked: '',
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalDollars: 0,
      })
    }

    const entry = acc.get(currentSkill)!
    if (newInvocation) {
      entry.invocations++
      if (!entry.lastInvoked || currentSkillTs > entry.lastInvoked) {
        entry.lastInvoked = currentSkillTs
      }
      newInvocation = false
    }
    entry.inputTokens += input
    entry.outputTokens += output
    entry.cacheCreationTokens += cacheCreate
    entry.cacheReadTokens += cacheRead
    entry.totalDollars += dollars
  }
}

export function computeActiveCost(validSkills?: Set<string>, since?: Date): ActiveCostEntry[] {
  const skills = validSkills ?? new Set(discoverAllSkills().map(s => s.name))
  const acc = new Map<string, ActiveCostEntry>()
  for (const file of findSessionFiles()) {
    parseSessionActiveCost(file, acc, skills, since)
  }
  return Array.from(acc.values()).sort((a, b) => b.totalDollars - a.totalDollars)
}

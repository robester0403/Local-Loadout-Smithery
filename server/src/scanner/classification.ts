import type { Skill, SkillType, ClassificationResult } from './types'

// Imperative verbs that strongly signal a body is meant to be a /command invocation.
const IMPERATIVE_VERBS = new Set([
  'generate', 'create', 'run', 'execute', 'build', 'update', 'list', 'show', 'write', 'audit',
])

// Meta-language that marks a body as belonging to a skill or subagent, not a bare command.
const META_LANGUAGE = ['this skill', 'use when', 'you are', 'your role is', 'act as']

const SUBAGENT_OPENERS = ['you are an', 'you are a', 'act as', 'your role is']
const DELEGATION_WORDS = ['delegate', 'autonomous', 'spawn', 'orchestrate', 'coordinate', 'subagents', 'sub-agent']

const DISCLOSURE_PHRASES = ['use when', 'if the user', 'triggers']

// Two positive semantic signals for each type.
// Body length is intentionally NOT a command cue — it applies to almost everything and
// creates false "correctly typed" results when a command body has subagent/skill language.

function getCommandCues(body: string): string[] {
  const cues: string[] = []
  const lower = body.toLowerCase()

  const firstWord = body.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? ''
  if (IMPERATIVE_VERBS.has(firstWord)) {
    cues.push(`Opens with imperative verb "${firstWord}"`)
  }

  const hasMetaLanguage = META_LANGUAGE.some(p => lower.includes(p))
  if (!hasMetaLanguage) {
    cues.push('No skill/agent meta-language ("this skill", "use when", "you are")')
  }

  return cues
}

function getSubagentCues(body: string): string[] {
  const cues: string[] = []
  const first200 = body.slice(0, 200).toLowerCase()

  const opener = SUBAGENT_OPENERS.find(p => first200.includes(p))
  if (opener) {
    cues.push(`Role declaration in opener: "${opener}"`)
  }

  const lower = body.toLowerCase()
  const delegation = DELEGATION_WORDS.find(w => lower.includes(w))
  if (delegation) {
    cues.push(`References autonomous/delegation behavior: "${delegation}"`)
  }

  return cues
}

function getSkillCues(body: string): string[] {
  const cues: string[] = []
  const lower = body.toLowerCase()

  if (lower.includes('use when')) {
    cues.push('Contains "use when"')
  }
  if (lower.includes('this skill supports')) {
    cues.push('Contains "this skill supports"')
  }
  const sysMatch = /the \w+ (system|module|component) handles/i.exec(body)
  if (sysMatch) {
    cues.push(`System-handler phrase: "${sysMatch[0]}"`)
  }
  for (const p of DISCLOSURE_PHRASES) {
    if (lower.includes(p) && !cues.some(c => c.includes(`"${p}"`))) {
      cues.push(`Progressive-disclosure phrase: "${p}"`)
    }
  }

  return cues
}

function cuesForType(type: SkillType, body: string): string[] {
  if (type === 'command') return getCommandCues(body)
  if (type === 'subagent') return getSubagentCues(body)
  return getSkillCues(body)
}

export function inferType(skill: Pick<Skill, 'type' | 'body'>): ClassificationResult | null {
  const { type, body } = skill

  // If the body already has cues matching the current type, it's not misclassified.
  const currentCues = cuesForType(type, body)
  if (currentCues.length > 0) return null

  const allTypes: SkillType[] = ['command', 'subagent', 'skill']
  const candidates = allTypes
    .filter(t => t !== type)
    .map(t => ({ suggested: t, cues: cuesForType(t, body) }))
    .filter(c => c.cues.length >= 2)
    .sort((a, b) => b.cues.length - a.cues.length)

  if (candidates.length === 0) return null

  const best = candidates[0]!
  return { suggested: best.suggested, confidence: 'high', cues: best.cues }
}

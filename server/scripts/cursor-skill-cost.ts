#!/usr/bin/env tsx
// Cursor per-skill attribution proof. Run against the user's actual Cursor
// SQLite to verify the toolFormerData signal works end-to-end before we
// build out a full Cursor module on the server.
//
//   tsx server/scripts/cursor-skill-cost.ts
//
// Algorithm (derived from research, see PR description):
//   1. Open Cursor's globalStorage state.vscdb.
//   2. Stream every cursorDiskKV row whose key starts with 'bubbleId:'.
//   3. For each bubble whose toolFormerData.name is read_file / read_file_v2 /
//      Read AND whose params reference '/SKILL.md', extract the skill name
//      from the path component immediately preceding '/SKILL.md'.
//   4. Attribute that bubble's tokenCount.{input,output}Tokens to that skill.
//
// This is the "first activation" signal only — it doesn't propagate forward
// across follow-up turns. Good enough to validate the approach.

import { execFileSync } from 'child_process'
import os from 'os'
import path from 'path'

const DB = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Cursor',
  'User',
  'globalStorage',
  'state.vscdb',
)

interface Bubble {
  composerId: string
  bubbleId: string
  type?: number               // 1 = user, 2 = assistant
  tokenCount?: { inputTokens?: number; outputTokens?: number }
  toolFormerData?: {
    name?: string
    params?: unknown
    rawArgs?: unknown
  }
  modelInfo?: { modelName?: string } | null
}

interface SkillHit {
  skill: string
  inputTokens: number
  outputTokens: number
  activations: number
}

function readBubbles(): Bubble[] {
  // Pre-filter at the SQL layer to bubbles that mention SKILL.md — there are
  // only ~hundreds of these out of tens of thousands. Use sqlite's -json mode
  // so the output is a single, valid JSON array (no per-line escaping issues).
  const out = execFileSync(
    'sqlite3',
    [
      '-json',
      DB,
      `SELECT key,
              json_extract(value, '$.type') AS type,
              json_extract(value, '$.tokenCount.inputTokens') AS inputTokens,
              json_extract(value, '$.tokenCount.outputTokens') AS outputTokens,
              json_extract(value, '$.toolFormerData.name') AS toolName,
              json_extract(value, '$.toolFormerData.params') AS toolParams,
              json_extract(value, '$.toolFormerData.rawArgs') AS toolRawArgs
       FROM cursorDiskKV
       WHERE key LIKE 'bubbleId:%' AND value LIKE '%SKILL.md%';`,
    ],
    { maxBuffer: 1024 * 1024 * 256, encoding: 'utf-8' },
  )

  if (!out.trim()) return []
  let rows: Array<Record<string, unknown>>
  try {
    rows = JSON.parse(out) as Array<Record<string, unknown>>
  } catch {
    return []
  }

  const bubbles: Bubble[] = []
  for (const row of rows) {
    const key = row['key'] as string
    const parts = key.split(':')
    if (parts.length < 3) continue
    bubbles.push({
      composerId: parts[1],
      bubbleId: parts.slice(2).join(':'),
      type: row['type'] as number | undefined,
      tokenCount: {
        inputTokens: (row['inputTokens'] as number | null) ?? 0,
        outputTokens: (row['outputTokens'] as number | null) ?? 0,
      },
      toolFormerData: {
        name: row['toolName'] as string | undefined,
        params: row['toolParams'] as unknown,
        rawArgs: row['toolRawArgs'] as unknown,
      },
    })
  }
  return bubbles
}

const SKILL_TOOL_NAMES = new Set(['read_file', 'read_file_v2', 'Read'])

function extractSkillName(params: unknown, rawArgs: unknown): string | null {
  // Look for a SKILL.md path in either field. They can be objects or strings.
  const candidate = (() => {
    const fromParams = pickPathLike(params)
    if (fromParams) return fromParams
    return pickPathLike(rawArgs)
  })()
  if (!candidate) return null
  if (!candidate.endsWith('/SKILL.md')) return null
  // path: .../skills-cursor/foo/SKILL.md → 'foo'
  const segments = candidate.split('/')
  if (segments.length < 2) return null
  return segments[segments.length - 2]
}

// Walk the value tree looking for a string that ENDS with '/SKILL.md'. The
// leaf check must be `endsWith` rather than `includes`: a JSON-encoded
// envelope like `{"targetFile":"…/SKILL.md","limit":30}` contains the
// substring but isn't itself a path, so an `includes` check short-circuits
// before recursing into the object and returns garbage to the caller.
function pickPathLike(v: unknown): string | null {
  if (typeof v === 'string') {
    if (v.endsWith('/SKILL.md')) return v
    // Otherwise try parsing as JSON and recurse into the parsed structure.
    // params and rawArgs are sometimes stringified, sometimes not.
    try {
      const inner = JSON.parse(v) as unknown
      // Guard against trivial loops: JSON.parse('"foo"') → 'foo'.
      if (typeof inner === 'string' && inner === v) return null
      return pickPathLike(inner)
    } catch {
      return null
    }
  }
  if (v && typeof v === 'object') {
    for (const value of Object.values(v as Record<string, unknown>)) {
      const r = pickPathLike(value)
      if (r) return r
    }
  }
  return null
}

function main(): void {
  console.log(`Reading ${DB}…`)
  const bubbles = readBubbles()
  console.log(`Loaded ${bubbles.length} bubbles.`)

  const tally = new Map<string, SkillHit>()
  let assistantBubbles = 0
  let toolBubbles = 0
  let skillReadBubbles = 0

  for (const b of bubbles) {
    if (b.type !== 2) continue
    assistantBubbles++
    const tfd = b.toolFormerData
    if (!tfd?.name) continue
    toolBubbles++
    if (!SKILL_TOOL_NAMES.has(tfd.name)) continue
    const skill = extractSkillName(tfd.params, tfd.rawArgs)
    if (!skill) continue
    skillReadBubbles++

    const entry = tally.get(skill) ?? {
      skill, inputTokens: 0, outputTokens: 0, activations: 0,
    }
    entry.inputTokens += b.tokenCount?.inputTokens ?? 0
    entry.outputTokens += b.tokenCount?.outputTokens ?? 0
    entry.activations += 1
    tally.set(skill, entry)
  }

  console.log('')
  console.log(`Assistant bubbles:        ${assistantBubbles}`)
  console.log(`With tool calls:          ${toolBubbles}`)
  console.log(`SKILL.md reads detected:  ${skillReadBubbles}`)
  console.log(`Distinct skills attributed: ${tally.size}`)
  console.log('')

  const rows = Array.from(tally.values()).sort((a, b) => b.activations - a.activations)
  if (rows.length === 0) {
    console.log('No skill activations found in this database.')
    return
  }

  // Print a tidy table.
  const w = (s: string, n: number) => s.padEnd(n)
  console.log(w('SKILL', 38) + w('ACTIVATIONS', 14) + w('INPUT TOKENS', 16) + 'OUTPUT TOKENS')
  console.log('─'.repeat(96))
  for (const r of rows) {
    console.log(
      w(r.skill, 38) +
      w(String(r.activations), 14) +
      w(r.inputTokens.toLocaleString(), 16) +
      r.outputTokens.toLocaleString(),
    )
  }
}

main()

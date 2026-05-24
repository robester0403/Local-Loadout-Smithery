// Rule accept helper (LOC-78). Appends a rule candidate's text into the
// ecosystem's global instructions file (CLAUDE.md / AGENTS.md), wrapped in
// `<!-- LS-rule:<id> start --> … <!-- LS-rule:<id> end -->` markers so a
// future tracking ticket (see LOC-69's deferred-work note) can find them.
//
// Idempotent: re-accepting the same rule (same text + section) yields the
// same marker id and is a no-op.

import fs from 'fs'
import path from 'path'
import { atomicWrite } from '../lib/atomicWrite'
import {
  computeRuleMarkerId,
  ruleMarkerStart,
  ruleMarkerEnd,
} from './signals/lib/ruleMarkers'

const DEFAULT_SECTION = 'Conventions'

export interface RuleEmitOptions {
  /** Absolute path to the account directory (~/.claude, ~/.cursor, ~/.codex). */
  accountDir: string
  /** The rule body to append. */
  ruleText: string
  /** H2 heading under which to nest the rule. Default 'Conventions'. */
  suggestedSection?: string
}

export interface RuleEmitResult {
  /** The md file we wrote to. */
  path: string
  /** False if the rule was already present (idempotent no-op). */
  appended: boolean
  /** The stable id used in the LS-rule marker. */
  markerId: string
}

/**
 * Map an account directory to its global-instructions md file.
 * - ~/.claude            → CLAUDE.md
 * - ~/.cursor, ~/.codex  → AGENTS.md
 *
 * Per the LOC-78 audit comment: all three ecosystems are supported by this
 * one helper (parity rule).
 */
export function resolveRuleFile(accountDir: string): string {
  const base = path.basename(accountDir)
  if (base === '.claude' || base.startsWith('.claude-')) {
    return path.join(accountDir, 'CLAUDE.md')
  }
  return path.join(accountDir, 'AGENTS.md')
}

export function emitRuleAppend(opts: RuleEmitOptions): RuleEmitResult {
  const section = (opts.suggestedSection || DEFAULT_SECTION).trim() || DEFAULT_SECTION
  const ruleText = opts.ruleText.trim()
  if (ruleText.length === 0) {
    throw new Error('emitRuleAppend: ruleText is empty')
  }

  const file = resolveRuleFile(opts.accountDir)
  const markerId = computeRuleMarkerId(ruleText, section)
  const startMarker = ruleMarkerStart(markerId)

  const body = readBody(file)
  if (body.includes(startMarker)) {
    // Already there — idempotent no-op.
    return { path: file, appended: false, markerId }
  }

  const next = appendRuleBlock(body, section, ruleText, markerId)
  atomicWrite(file, next)
  return { path: file, appended: true, markerId }
}

function readBody(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return ''
  }
}

/**
 * Append a marker-wrapped rule block under the target H2 section. If the
 * section doesn't exist, create it at the end of the file.
 *
 * Section detection is line-anchored on `## <name>` (case-insensitive). The
 * insertion point is just before the next H1/H2 heading after the section
 * start, or end-of-file if none.
 */
export function appendRuleBlock(
  body: string,
  section: string,
  ruleText: string,
  markerId: string,
): string {
  const ruleBlock = [
    ruleMarkerStart(markerId),
    ruleText,
    ruleMarkerEnd(markerId),
  ].join('\n')

  const sectionPos = findSectionLine(body, section)
  if (sectionPos === -1) {
    // No matching section — create one at the end.
    const trimmed = body.replace(/\n+$/, '')
    const prefix = trimmed.length > 0 ? trimmed + '\n\n' : ''
    return `${prefix}## ${section}\n\n${ruleBlock}\n`
  }

  const lines = body.split('\n')
  const sectionLineIdx = sectionPos

  // Find the next H1 or H2 after the section line; insert just before it.
  let insertLine = lines.length
  for (let i = sectionLineIdx + 1; i < lines.length; i++) {
    const l = lines[i]
    if (/^#{1,2}\s+\S/.test(l)) { insertLine = i; break }
  }

  // Trim trailing blank lines inside the section so the new block doesn't
  // create a triple-blank run.
  let trimmedEnd = insertLine
  while (trimmedEnd > sectionLineIdx + 1 && lines[trimmedEnd - 1].trim() === '') trimmedEnd--

  const before = lines.slice(0, trimmedEnd).join('\n')
  const after = lines.slice(insertLine).join('\n')

  const beforeNeedsBlank = before.length > 0 && !before.endsWith('\n\n')
  const sep = beforeNeedsBlank ? '\n\n' : ''
  const afterPrefix = after.length > 0 ? '\n\n' : '\n'

  return `${before}${sep}${ruleBlock}${afterPrefix}${after}`
}

function findSectionLine(body: string, section: string): number {
  const target = section.trim().toLowerCase()
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+(.+?)\s*$/.exec(lines[i])
    if (m && m[1].trim().toLowerCase() === target) return i
  }
  return -1
}

// Test seam
export const __test = { resolveRuleFile, appendRuleBlock, findSectionLine }

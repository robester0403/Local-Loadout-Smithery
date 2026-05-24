// Helpers for the rule artifact tracking workaround (see LOC-69 comment
// "Known gap deferred: rule artifact tracking"). Until full tracking lands
// in a future ticket, accepted rule candidates are wrapped in HTML-comment
// markers inside the destination md file:
//
//   <!-- LS-rule:<stable-id> start -->
//   {rule text}
//   <!-- LS-rule:<stable-id> end -->
//
// The stable-id is derived from a hash of (suggestedSection || '') + ruleText,
// so the same rule produces the same marker when re-proposed across digests.
// This lets the next run's rule detector cheaply dedup against rules WE
// previously appended without needing a separate tracking store.

import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

const MARKER_PREFIX = 'LS-rule:'
const MARKER_START_RE = /<!--\s*LS-rule:([A-Za-z0-9_-]+)\s+start\s*-->/g

export function computeRuleMarkerId(ruleText: string, suggestedSection?: string): string {
  const norm = `${(suggestedSection ?? '').trim().toLowerCase()}\n${ruleText.trim().toLowerCase()}`
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16)
}

export function ruleMarkerStart(id: string): string {
  return `<!-- ${MARKER_PREFIX}${id} start -->`
}

export function ruleMarkerEnd(id: string): string {
  return `<!-- ${MARKER_PREFIX}${id} end -->`
}

/** Parse all `<!-- LS-rule:<id> start -->` markers out of a md file body. */
export function extractRuleMarkerIds(body: string): Set<string> {
  const out = new Set<string>()
  let m: RegExpExecArray | null
  // MARKER_START_RE has the /g flag; reset lastIndex per call so the function
  // is reentrant.
  MARKER_START_RE.lastIndex = 0
  while ((m = MARKER_START_RE.exec(body)) != null) out.add(m[1])
  return out
}

/**
 * Existing rule-bearing files across all three ecosystems. The rule detector
 * (LOC-74) dedups against the union of (a) marker ids and (b) the raw text
 * body via embedding similarity.
 *
 * Files that don't exist are simply omitted — there's no error condition for
 * "user doesn't use Cursor", that's just an empty slot.
 */
export interface ExistingRuleFile {
  /** Absolute path, exposed for diagnostics. */
  file: string
  source: 'claude' | 'cursor' | 'codex'
  body: string
  markerIds: Set<string>
}

const DEFAULT_TARGETS: Array<{ file: string; source: 'claude' | 'cursor' | 'codex' }> = [
  { file: path.join(os.homedir(), '.claude', 'CLAUDE.md'), source: 'claude' },
  { file: path.join(os.homedir(), '.cursor', 'AGENTS.md'), source: 'cursor' },
  { file: path.join(os.homedir(), '.codex', 'AGENTS.md'), source: 'codex' },
]

export function readExistingRuleFiles(
  targets: Array<{ file: string; source: 'claude' | 'cursor' | 'codex' }> = DEFAULT_TARGETS,
): ExistingRuleFile[] {
  const out: ExistingRuleFile[] = []
  for (const t of targets) {
    let body: string
    try {
      body = fs.readFileSync(t.file, 'utf-8')
    } catch {
      continue
    }
    out.push({
      file: t.file,
      source: t.source,
      body,
      markerIds: extractRuleMarkerIds(body),
    })
  }
  return out
}

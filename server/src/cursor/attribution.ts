// Skill activation detection from a Cursor bubble's toolFormerData.
//
// Cursor's skills implementation is prompt-injected — the agent reads
// SKILL.md from a known absolute path when it wants to use a skill. That
// produces a tool call (`read_file_v2`/`read_file`/`Read`) whose args
// reference the SKILL.md path. We treat that read as the activation event.
//
// This is the "first activation" signal only. If the same skill stays in
// context across follow-up turns, we don't separately re-attribute those.
// Good enough to rank skills by usage volume.

import type { CursorToolCall } from './db'

const SKILL_TOOL_NAMES = new Set(['read_file', 'read_file_v2', 'Read'])

// SKILL.md only counts when it's inside one of these directory segments.
// Filters out e.g. a SKILL.md in ~/Downloads or sample files in cloned repos.
const LOADOUT_DIR_RE = /\/(?:skills|skills-cursor|agents|commands)\//

/**
 * Recursive walk looking for a string ending in `/SKILL.md`. Important:
 * the leaf check is `endsWith` rather than `includes`. A JSON-encoded
 * envelope like `{"targetFile":"…/SKILL.md","limit":30}` contains the
 * substring but isn't itself a path; without the strict suffix check we'd
 * return the whole envelope and downstream code would fail to extract a
 * skill name from it.
 */
export function pickSkillPath(v: unknown): string | null {
  if (typeof v === 'string') {
    if (v.endsWith('/SKILL.md')) return v
    // Cursor sometimes double-encodes — try parsing the string as JSON and
    // recursing. Guard against trivial loops where parsing returns the same
    // string (e.g. JSON.parse('"foo"') → 'foo').
    try {
      const inner = JSON.parse(v) as unknown
      if (typeof inner === 'string' && inner === v) return null
      return pickSkillPath(inner)
    } catch {
      return null
    }
  }
  if (v && typeof v === 'object') {
    for (const value of Object.values(v as Record<string, unknown>)) {
      const r = pickSkillPath(value)
      if (r) return r
    }
  }
  return null
}

/**
 * Returns the skill name if `tool` represents a SKILL.md read inside a
 * recognized loadout directory; null otherwise. Skill name is the path
 * segment immediately preceding `/SKILL.md`.
 */
export function extractSkillName(tool: CursorToolCall): string | null {
  if (!tool.name || !SKILL_TOOL_NAMES.has(tool.name)) return null
  const candidate = pickSkillPath(tool.params) ?? pickSkillPath(tool.rawArgs)
  if (!candidate) return null
  if (!LOADOUT_DIR_RE.test(candidate)) return null
  // .../skills-cursor/foo/SKILL.md → 'foo'
  const segments = candidate.split('/')
  if (segments.length < 2) return null
  return segments[segments.length - 2]
}

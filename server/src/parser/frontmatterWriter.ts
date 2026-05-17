// Updates a markdown file's frontmatter description and/or body, preserving
// everything else byte-for-byte. Companion to `parseFrontmatter` — but where
// the parser is permissive (returns whatever it can), the writer is strict so
// we never corrupt a file with malformed YAML.
//
// Encoding rules for description (see `formatYamlString`):
//   - newlines normalized to single spaces (frontmatter is line-based)
//   - double quotes and backslashes rejected (the parser doesn't unescape,
//     so round-tripping would garble the user's text)
//   - value always wrapped in double quotes on write — predictable parsing,
//     no ambiguity around `:` / `#` / leading sigils
//
// File semantics:
//   - If the file has no frontmatter and a description update is requested,
//     a new `---` block is prepended with just the description.
//   - Body updates rewrite everything after the closing `---` verbatim.
//   - The write is atomic (temp file + rename) so a crash mid-write never
//     leaves the skill in a partially-written state.

import fs from 'fs'
import path from 'path'

export interface UpdatePatch {
  description?: string
  body?: string
}

export class FrontmatterWriteError extends Error {
  readonly code: 'invalid-description'
  constructor(code: 'invalid-description', message: string) {
    super(message)
    this.code = code
  }
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/

export function updateSkillFile(filePath: string, patch: UpdatePatch): void {
  if (patch.description === undefined && patch.body === undefined) return

  const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''
  const match = raw.match(FRONTMATTER_RE)

  const oldHeader = match ? match[1] : ''
  const oldBody = match ? match[2] : raw

  const newHeader = patch.description !== undefined
    ? upsertDescription(oldHeader, patch.description)
    : oldHeader
  const newBody = patch.body !== undefined ? patch.body : oldBody

  const hasHeader = newHeader.length > 0 || match !== null
  const next = hasHeader
    ? `---\n${newHeader}\n---\n${newBody}`
    : newBody

  atomicWrite(filePath, next)
}

// Replace an existing `description:` line in `header` with the new value.
// If no such line exists, append one. Preserves all other lines, ordering,
// and any indentation the original used.
function upsertDescription(header: string, description: string): string {
  const encoded = `description: ${formatYamlString(description)}`
  const lines = header.length > 0 ? header.split('\n') : []
  const idx = lines.findIndex(l => /^\s*description\s*:/.test(l))
  if (idx >= 0) {
    lines[idx] = encoded
  } else {
    lines.push(encoded)
  }
  return lines.join('\n')
}

// Defensive YAML scalar encoding. See file header for rules.
function formatYamlString(value: string): string {
  const normalized = value.replace(/\r?\n/g, ' ').trim()
  if (normalized.includes('"')) {
    throw new FrontmatterWriteError(
      'invalid-description',
      'Description cannot contain double quotes — please remove them or use single quotes.',
    )
  }
  if (normalized.includes('\\')) {
    throw new FrontmatterWriteError(
      'invalid-description',
      'Description cannot contain backslashes.',
    )
  }
  return `"${normalized}"`
}

// Write via a sibling temp file in the same directory so the rename is atomic
// on the same volume. Skill files always live under the user's home dir, so
// the temp file is guaranteed same-volume — no cross-device fallback needed.
function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  const tmp = path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}`)
  fs.writeFileSync(tmp, content, 'utf-8')
  try {
    fs.renameSync(tmp, filePath)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* swallow cleanup error */ }
    throw err
  }
}

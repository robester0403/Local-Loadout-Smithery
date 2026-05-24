import fs from 'fs'
import path from 'path'
import { findAccounts } from '../scanner/discover'
import { assertWithinHome, HttpError } from '../lib/paths'
import { setStatus } from './store'
import { emitRuleAppend } from './emitRule'
import { loadExistingInventory } from './signals/existingInventory'
import type { Candidate, CandidateType } from './types'

export interface EmitOptions {
  /** Absolute path of the account directory (e.g. ~/.claude). Must be one of
   *  the dirs `findAccounts()` returns. */
  accountDir: string
  /** 'global' writes under the accountDir; 'project' under <projectPath>/. */
  scope: 'global' | 'project'
  projectPath?: string
  /** Overrides for the candidate's pending fields. */
  name: string
  description: string
  body: string
  type: CandidateType
}

function sanitizeName(name: string): string {
  const safe = name.toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!safe) throw new HttpError(400, 'Name is empty after sanitization')
  return safe.slice(0, 60)
}

function destinationPath(opts: EmitOptions): string {
  const baseDir = opts.scope === 'global'
    ? opts.accountDir
    : (() => {
        if (!opts.projectPath) throw new HttpError(400, 'projectPath required for project scope')
        // Project skills always live under .claude/ at the project root,
        // matching the scanner's expectation regardless of which account
        // is "selected" — we use the account choice only to keep frontmatter
        // conventions consistent.
        return path.join(opts.projectPath, '.claude')
      })()
  const slug = sanitizeName(opts.name)
  switch (opts.type) {
    case 'skill':
      return path.join(baseDir, 'skills', slug, 'SKILL.md')
    case 'command':
      return path.join(baseDir, 'commands', slug + '.md')
    case 'subagent':
      return path.join(baseDir, 'agents', slug + '.md')
    case 'rule':
      // Rule candidates land as text blocks inside CLAUDE.md / AGENTS.md.
      // The actual write happens in emitRuleAppend (called from
      // emitFromCandidate's rule branch); this case is unreachable in the
      // normal flow but kept exhaustive for the type checker.
      throw new HttpError(500, 'Rule candidates use the append path, not destinationPath')
  }
}

function yamlEscape(s: string): string {
  // Quote if YAML would otherwise misparse. Hyphens mid-string are fine; we
  // only worry about a leading sigil character, a ': ' sequence, an embedded
  // quote, or surrounding whitespace.
  const flat = s.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
  const startsWithSigil = /^[-?:,\[\]{}#&*!|>'"%@`]/.test(flat)
  const hasColonSpace = /:\s/.test(flat) || flat.endsWith(':')
  const hasQuote = /["']/.test(flat)
  if (startsWithSigil || hasColonSpace || hasQuote) {
    return JSON.stringify(flat)
  }
  return flat
}

function renderFile(opts: EmitOptions): string {
  const slug = sanitizeName(opts.name)
  const fm = [
    '---',
    `name: ${yamlEscape(slug)}`,
    `description: ${yamlEscape(opts.description)}`,
    '---',
    '',
  ].join('\n')
  return fm + opts.body.trim() + '\n'
}

export function emitFromCandidate(c: Candidate, opts: EmitOptions): { path: string; candidate: Candidate } {
  const accounts = new Set(findAccounts())
  if (!accounts.has(opts.accountDir)) {
    throw new HttpError(400, `Unknown account dir: ${opts.accountDir}`)
  }

  // Rule candidates append to the ecosystem's global instructions file
  // (CLAUDE.md or AGENTS.md). All other kinds create a new file per
  // destinationPath().
  if (opts.type === 'rule') {
    const ruleText = (opts.body && opts.body.trim()) || c.ruleText || c.bodyDraft
    if (!ruleText.trim()) throw new HttpError(400, 'Rule candidate has no body to append')
    const suggestedSection = c.suggestedSection
    const result = emitRuleAppend({
      accountDir: opts.accountDir,
      ruleText,
      suggestedSection,
    })
    assertWithinHome(result.path)
    const updated = setStatus(c.id, 'accepted', result.path)
    return { path: result.path, candidate: updated }
  }

  // Belt-and-suspenders (LOC-89): reject cross-type slug collisions. The
  // upstream pipeline filters these out, but a candidate written by the
  // legacy free-form digest (which had no cross-type pass) or one accepted
  // long after a colliding artifact was installed manually can still land
  // here. The filesystem layout puts skills/commands/subagents in different
  // sub-directories, so a plain fs.existsSync check would miss it.
  const slug = sanitizeName(opts.name)
  const collision = loadExistingInventory().find(a => sanitizeName(a.name) === slug && a.kind !== opts.type)
  if (collision) {
    throw new HttpError(409, `Slug "${slug}" already used by existing ${collision.kind} at ${collision.path}`)
  }

  const dest = destinationPath(opts)
  assertWithinHome(dest)
  if (fs.existsSync(dest)) {
    throw new HttpError(409, `File already exists: ${dest}`)
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, renderFile(opts))
  const updated = setStatus(c.id, 'accepted', dest)
  return { path: dest, candidate: updated }
}

export const __test = { renderFile, destinationPath, sanitizeName }

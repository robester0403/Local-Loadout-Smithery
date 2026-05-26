// SuperRouter Reapply reconciliation (LOC-87).
//
// Skill IDs are `base64(realpath)`. When a referenced skill is renamed,
// moved, reclassified, or symlink-redirected, its ID changes — and the
// bundle's stored reference goes stale. Without help, Reapply fails with
// "Some selected skills no longer exist" and the user is stuck.
//
// This module is the surgical fix: for any bundle skill whose ID doesn't
// resolve, decode the path, extract (name, type, account), and look up the
// new live ID by that stable triple. The fast path (ID still resolves) is
// untouched — no decode, no allocation beyond the byId Map lookup.
//
// Pure function. No I/O. The caller (route) is responsible for persisting
// the reconciled bundle and surfacing the {healed, missing, ambiguous}
// outputs to the user.

import path from 'path'
import type { Skill, SkillType } from '../scanner/types'
import type { BundleSkillEntry } from './types'

export interface DecodedBundleSkillPath {
  /** Best-effort name extracted from the path (directory name for SKILL.md,
   *  basename for .md). Empty if undecodable. */
  name: string
  /** Best-effort type from the parent folder. Null if not under one of
   *  skills/ commands/ agents/. */
  type: SkillType | null
  /** Best-effort account label ('default', 'cursor', 'codex', 'work', ...).
   *  Empty if no recognizable account segment was found. */
  account: string
  /** The full decoded path, for surfacing to the user when no match is found. */
  decodedPath: string
}

export interface HealedEntry {
  /** Original (stale) ID stored in the bundle. */
  from: string
  /** New ID we resolved it to. */
  to: string
  /** Human-readable name for the toast. */
  name: string
}

export interface MissingEntry {
  /** The original bundle entry (unchanged — we don't drop it). */
  entry: BundleSkillEntry
  decoded: DecodedBundleSkillPath
}

export interface AmbiguousEntry {
  entry: BundleSkillEntry
  decoded: DecodedBundleSkillPath
  matches: Skill[]
}

export interface ReconcileResult {
  /** The skills to feed to applyBundle. Includes healed entries with their
   *  new IDs. Excludes missing + ambiguous entries (the on-disk map should
   *  reflect only what we can render). */
  resolved: BundleSkillEntry[]
  /** Entries whose ID changed but were successfully matched by (name, type,
   *  account). Worth surfacing so the user sees that drift was healed. */
  healed: HealedEntry[]
  /** Entries we couldn't find at all. Retained in the bundle store so the
   *  user doesn't silently lose the reference. */
  missing: MissingEntry[]
  /** Entries with multiple matches — defensive. Same treatment as missing. */
  ambiguous: AmbiguousEntry[]
}

/**
 * Decode the base64-encoded path stored in a bundle's skill ID and tease out
 * the stable identity bits. Robust to malformed input — every field falls
 * back to a sensible empty value rather than throwing.
 */
export function decodeBundleSkillPath(id: string): DecodedBundleSkillPath {
  let decoded = ''
  try {
    decoded = Buffer.from(id, 'base64').toString('utf-8')
  } catch {
    return { name: '', type: null, account: '', decodedPath: '' }
  }
  if (!decoded.startsWith('/')) {
    // Not an absolute path — give up on structural extraction.
    return { name: '', type: null, account: '', decodedPath: decoded }
  }

  const segments = decoded.split(path.sep)
  // Find the account-bearing segment (.claude / .claude-* / .cursor / .codex).
  let account = ''
  let accountIdx = -1
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    if (s === '.claude') { account = 'default'; accountIdx = i; break }
    if (s.startsWith('.claude-')) { account = s.slice('.claude-'.length); accountIdx = i; break }
    if (s === '.cursor') { account = 'cursor'; accountIdx = i; break }
    if (s === '.codex') { account = 'codex'; accountIdx = i; break }
  }

  // The kind segment is the next one (skills / commands / agents). For
  // project-scope skills the path looks like
  //   <cwd>/.claude/skills/<name>/SKILL.md
  // so the same offset works for project + global.
  const kindSeg = accountIdx >= 0 ? segments[accountIdx + 1] : ''
  let type: SkillType | null = null
  if (kindSeg === 'skills') type = 'skill'
  else if (kindSeg === 'commands') type = 'command'
  else if (kindSeg === 'agents') type = 'subagent'

  // Name extraction depends on type.
  let name = ''
  if (type === 'skill') {
    // .../skills/<name>/SKILL.md — directory name above SKILL.md
    const basename = segments[segments.length - 1]
    const dir = segments[segments.length - 2] ?? ''
    if (basename === 'SKILL.md') name = dir
  } else if (type === 'command' || type === 'subagent') {
    // .../commands/<name>.md — bare file
    // .../commands/<ns>/<sub>.md — namespaced as "ns:sub"
    const basename = segments[segments.length - 1]
    if (basename.endsWith('.md')) {
      const stem = basename.slice(0, -'.md'.length)
      // Detect namespace: account/kind/<ns>/<sub>.md vs account/kind/<sub>.md
      const kindIdx = accountIdx + 1
      if (segments.length - 1 - kindIdx === 2) {
        // Two segments after kind → namespaced
        const ns = segments[kindIdx + 1]
        name = `${ns}:${stem}`
      } else {
        name = stem
      }
    }
  }

  return { name, type, account, decodedPath: decoded }
}

/**
 * Reconcile a bundle's stored skill entries against the current live
 * inventory. Pure — no I/O. Entries whose ID still resolves are returned
 * verbatim with no work performed; only stale entries trigger decode +
 * lookup.
 */
export function reconcileBundleSkills(
  bundleSkills: BundleSkillEntry[],
  inventory: Skill[],
): ReconcileResult {
  const byId = new Map(inventory.map(s => [s.id, s]))

  const resolved: BundleSkillEntry[] = []
  const healed: HealedEntry[] = []
  const missing: MissingEntry[] = []
  const ambiguous: AmbiguousEntry[] = []

  for (const entry of bundleSkills) {
    // Fast path: ID still matches — pass through with zero extra work.
    if (byId.has(entry.id)) {
      resolved.push(entry)
      continue
    }

    // Slow path: only stale entries pay decode + linear-scan cost.
    const decoded = decodeBundleSkillPath(entry.id)

    // If we couldn't extract enough signal to look anything up, classify
    // as missing — better than scanning the whole inventory blind.
    if (!decoded.name || !decoded.account) {
      missing.push({ entry, decoded })
      continue
    }

    // Primary match: exact (name, type, account).
    const exact = decoded.type !== null
      ? inventory.filter(s =>
          s.name === decoded.name &&
          s.type === decoded.type &&
          s.account === decoded.account)
      : []

    if (exact.length === 1) {
      const found = exact[0]
      healed.push({ from: entry.id, to: found.id, name: found.name })
      resolved.push({ ...entry, id: found.id })
      continue
    }
    if (exact.length > 1) {
      ambiguous.push({ entry, decoded, matches: exact })
      continue
    }

    // Fallback: same name + account, any type. Catches reclassify
    // (skill → command, etc).
    const crossType = inventory.filter(s =>
      s.name === decoded.name &&
      s.account === decoded.account)
    if (crossType.length === 1) {
      const found = crossType[0]
      healed.push({ from: entry.id, to: found.id, name: found.name })
      resolved.push({ ...entry, id: found.id })
      continue
    }
    if (crossType.length > 1) {
      ambiguous.push({ entry, decoded, matches: crossType })
      continue
    }

    // No match — truly gone.
    missing.push({ entry, decoded })
  }

  return { resolved, healed, missing, ambiguous }
}

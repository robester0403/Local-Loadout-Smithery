// Rule artifact tracking (LOC-86). Closes the "Known gap deferred" from LOC-69.
//
// Accepted rule candidates from the auto-skill pipeline (LOC-78) land as text
// blocks inside CLAUDE.md / AGENTS.md wrapped in:
//
//   <!-- LS-rule:<id> start -->
//   {rule text}
//   <!-- LS-rule:<id> end -->
//
// This module parses those blocks back out so the inventory can surface them
// as a tracked artifact kind — alongside skills / commands / subagents — and
// the existing uninstall path can excise them cleanly.
//
// The "id encoding" trick: each rule artifact gets a logical path of the form
//   <md-file>#LS-rule:<markerId>
// so it round-trips through the existing base64-encoded id wire format and
// the path-traversal guard in assertAllowedSkillPath (which checks for
// .claude / .cursor / .codex segments) without any special casing.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { countTokens } from '../usage/tokenizer'
import type { Skill, HealthResult } from './types'

const RULE_ID_SEP = '#LS-rule:'

const MARKER_START_RE = /^<!--\s*LS-rule:([A-Za-z0-9_-]+)\s+start\s*-->\s*$/
const MARKER_END_RE = /^<!--\s*LS-rule:([A-Za-z0-9_-]+)\s+end\s*-->\s*$/

export interface RuleArtifact {
  /** Marker id (16-char sha prefix derived from section + ruleText). */
  id: string
  /** Ecosystem label. */
  source: 'claude' | 'cursor' | 'codex'
  /** Absolute path to the md file the rule is embedded in. */
  file: string
  /** Account label written into Skill.account ('default', 'cursor', 'codex', 'work', etc.). */
  account: string
  /** Most recent `## Heading` above the start marker, or '' if none. */
  section: string
  /** Inner rule body (everything between start and end marker, trimmed). */
  ruleText: string
  /** 1-indexed line numbers of the start and end markers. */
  lineStart: number
  lineEnd: number
}

export interface RuleScanTarget {
  /** Absolute path to the md file to scan. */
  file: string
  source: 'claude' | 'cursor' | 'codex'
  /** Account label propagated to the Skill row. */
  account: string
}

/** Parse a single md file. Missing/unreadable files yield an empty list. */
export function parseRulesFromFile(target: RuleScanTarget): RuleArtifact[] {
  let body: string
  try {
    body = fs.readFileSync(target.file, 'utf-8')
  } catch {
    return []
  }
  return parseRulesFromBody(body, target)
}

/** Pure parse function — separable for tests. */
export function parseRulesFromBody(body: string, target: RuleScanTarget): RuleArtifact[] {
  const lines = body.split('\n')
  const out: RuleArtifact[] = []
  let currentSection = ''
  let inMarker: { id: string; startLine: number; bodyLines: string[] } | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (inMarker) {
      const endMatch = MARKER_END_RE.exec(line)
      if (endMatch && endMatch[1] === inMarker.id) {
        out.push({
          id: inMarker.id,
          source: target.source,
          file: target.file,
          account: target.account,
          section: currentSection,
          ruleText: inMarker.bodyLines.join('\n').trim(),
          lineStart: inMarker.startLine,
          lineEnd: i + 1,
        })
        inMarker = null
      } else {
        inMarker.bodyLines.push(line)
      }
      continue
    }

    const startMatch = MARKER_START_RE.exec(line)
    if (startMatch) {
      inMarker = { id: startMatch[1], startLine: i + 1, bodyLines: [] }
      continue
    }

    const headingMatch = /^##\s+(.+?)\s*$/.exec(line)
    if (headingMatch) currentSection = headingMatch[1].trim()
  }
  // Unterminated marker — silently dropped. The rule scanner's job is "find
  // installed rules"; a half-written marker isn't installed.

  return out
}

/** Default global targets for the discovered accounts. */
export function defaultRuleTargets(
  accountLabels: ReadonlyArray<string>,
  home: string = os.homedir(),
): RuleScanTarget[] {
  const out: RuleScanTarget[] = []
  for (const label of accountLabels) {
    if (label === 'cursor') {
      out.push({ file: path.join(home, '.cursor', 'AGENTS.md'), source: 'cursor', account: 'cursor' })
    } else if (label === 'codex') {
      out.push({ file: path.join(home, '.codex', 'AGENTS.md'), source: 'codex', account: 'codex' })
    } else {
      // Claude global lives at ~/.claude/CLAUDE.md for the default account or
      // ~/.claude-<label>/CLAUDE.md for additional accounts.
      const accountDir = label === 'default' ? '.claude' : `.claude-${label}`
      out.push({
        file: path.join(home, accountDir, 'CLAUDE.md'),
        source: 'claude',
        account: label,
      })
    }
  }
  return out
}

export function scanRuleArtifacts(targets: ReadonlyArray<RuleScanTarget>): RuleArtifact[] {
  const out: RuleArtifact[] = []
  for (const t of targets) out.push(...parseRulesFromFile(t))
  return out
}

/** Encode the synthetic logical path for a rule artifact. */
export function ruleLogicalPath(file: string, markerId: string): string {
  return `${file}${RULE_ID_SEP}${markerId}`
}

/** True if a decoded path describes a rule artifact (vs. a real file). */
export function isRuleLogicalPath(decoded: string): boolean {
  return decoded.includes(RULE_ID_SEP)
}

export interface ParsedRuleLogicalPath {
  file: string
  markerId: string
}

export function parseRuleLogicalPath(decoded: string): ParsedRuleLogicalPath | null {
  const idx = decoded.indexOf(RULE_ID_SEP)
  if (idx === -1) return null
  return {
    file: decoded.slice(0, idx),
    markerId: decoded.slice(idx + RULE_ID_SEP.length),
  }
}

/** Project a RuleArtifact into the inventory Skill wire format. */
export function ruleArtifactToSkill(a: RuleArtifact): Skill {
  const logicalPath = ruleLogicalPath(a.file, a.id)
  const id = Buffer.from(logicalPath).toString('base64')
  const name = a.ruleText.split('\n', 1)[0].slice(0, 80) || `rule-${a.id.slice(0, 6)}`
  const description = a.section
    ? `Rule (under "${a.section}") in ${path.basename(a.file)}`
    : `Rule in ${path.basename(a.file)}`
  const health: HealthResult = { status: 'ok', issues: [] }
  let lastModified = new Date().toISOString()
  // LOC-12 added `installedAt` to Skill; use the host md file's birthtime
  // (mtime fallback) so a freshly-accepted rule can light up the NEW badge
  // alongside file-backed skills.
  let installedAt = lastModified
  try {
    const stat = fs.statSync(a.file)
    lastModified = stat.mtime.toISOString()
    const birthMs = stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs
    installedAt = new Date(birthMs).toISOString()
  } catch {
    // Fallthrough — synthetic timestamp is fine if the file moves under us.
  }
  return {
    id,
    name,
    description,
    version: '',
    type: 'rule',
    scope: 'global',
    account: a.account,
    path: logicalPath,
    realpath: logicalPath,
    isSymlink: false,
    body: a.ruleText,
    bodyBytes: Buffer.byteLength(a.ruleText, 'utf-8'),
    bodyTokens: countTokens(a.ruleText),
    listingBytes: 0,
    listingTokens: 0,
    frontmatter: {
      'ls-rule-id': a.id,
      'ls-rule-file': a.file,
      'ls-rule-section': a.section,
      'ls-rule-line-start': a.lineStart,
      'ls-rule-line-end': a.lineEnd,
    },
    lastModified,
    installedAt,
    health,
    disabled: false,
    references: [],
    diagnostics: [],
    suggestedType: null,
  }
}

/**
 * Excise the marker-wrapped block (start + body + end) from `body`. Returns
 * the new content, or `null` if the marker is not present (idempotent no-op
 * signal — caller can avoid touching the file).
 *
 * Behavior:
 *  - Removes the start line, all lines between, and the end line.
 *  - Collapses surrounding blank-line whitespace so we don't leave a
 *    triple-blank run where the block used to be.
 *  - Other markers in the same file are untouched.
 */
export function exciseRuleBlock(body: string, markerId: string): string | null {
  const lines = body.split('\n')
  let startIdx = -1
  let endIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER_START_RE.exec(lines[i])
    if (m && m[1] === markerId) {
      startIdx = i
      for (let j = i + 1; j < lines.length; j++) {
        const e = MARKER_END_RE.exec(lines[j])
        if (e && e[1] === markerId) {
          endIdx = j
          break
        }
      }
      break
    }
  }
  if (startIdx === -1 || endIdx === -1) return null

  // Cut [startIdx, endIdx] inclusive. Then collapse adjacent blank lines:
  // if both sides have a trailing/leading blank we keep at most one.
  const before = lines.slice(0, startIdx)
  const after = lines.slice(endIdx + 1)

  // Drop one trailing blank from `before` if `after` starts with a blank,
  // so we don't end up with three consecutive newlines.
  while (before.length > 0 && before[before.length - 1] === '' && after.length > 0 && after[0] === '') {
    before.pop()
  }

  // If the block was at the tail of the file, `after` may be all-blank
  // (one entry per stray trailing newline). Collapse to a single trailing
  // newline so we don't leave a double-blank EOF run.
  if (after.every(l => l === '')) after.length = Math.min(after.length, 1)

  return [...before, ...after].join('\n')
}

// Body / description mention utilities for the RelationshipMap rail.
//
// All pure functions — no React, no DOM. The rail's info panel uses these to:
//   - find every occurrence of a known artifact name inside a body,
//     returning snippets with surrounding context (findBodyMentions)
//   - render a text block with each known-name occurrence wrapped in a
//     <strong> tagged with its source offset (highlightMentions)
//
// The two consumers share a common candidate set and word-boundary regex;
// it's built once via `buildMentionPattern` to keep the two in lockstep.

import { Fragment, type ReactNode } from 'react'

// Number of mention snippets shown before truncating. The rail has finite
// vertical space; beyond ~8 the panel becomes a wall of text.
export const MAX_BODY_MENTIONS = 8

// Characters of context shown on each side of a mention.
export const BODY_MENTION_CONTEXT = 100

export interface BodySnippet {
  before: string
  match: string
  after: string
  /** Character offset of the match within the full body. The rail uses this
   *  to scrollIntoView the exact occurrence when the snippet is clicked. */
  offset: number
  /** True when `before` was truncated from the body's start. */
  hasMore: boolean
  /** True when `after` was truncated to the body's end. */
  hasMoreAfter: boolean
}

/** Single-shot jump request from a snippet click. Re-firing with the same
 *  offset still triggers — keyed by an incrementing nonce. */
export interface BodyJump {
  /** Name of the mentioned artifact (graph navigation target). */
  name: string
  /** Character offset in the focused skill's body. */
  offset: number
  /** Bump on every click so identical follow-up clicks re-fire effects. */
  nonce: number
}

// Build the global, word-boundary-anchored regex used by both finders.
// Returns null when there are no eligible candidates so callers can fast-path.
// Longest-first ordering prevents a short name (e.g. "gh") from greedily
// matching inside a longer one ("gh-cli"). Boundaries use [\w:-] so internal
// hyphens / colons inside a name don't fragment a match.
function buildMentionPattern(
  names: ReadonlySet<string>,
  selfName: string,
): RegExp | null {
  const candidates = Array.from(names)
    .filter(n => n.length > 1 && n !== selfName)
    .sort((a, b) => b.length - a.length)
  if (candidates.length === 0) return null
  const pattern = candidates.map(escapeRegex).join('|')
  return new RegExp(`(?<![\\w:-])(?:${pattern})(?![\\w:-])`, 'g')
}

// Find every occurrence of any known artifact name in `body` (excluding
// `selfName`), returning each as a snippet with up to BODY_MENTION_CONTEXT
// characters of leading and trailing context. Capped at MAX_BODY_MENTIONS so
// a body that mentions one skill 200 times doesn't overwhelm the rail.
export function findBodyMentions(
  body: string,
  names: ReadonlySet<string>,
  selfName: string,
): BodySnippet[] {
  if (!body) return []
  const re = buildMentionPattern(names, selfName)
  if (!re) return []

  const out: BodySnippet[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(body)) !== null && out.length < MAX_BODY_MENTIONS) {
    const start = Math.max(0, match.index - BODY_MENTION_CONTEXT)
    const end = Math.min(body.length, match.index + match[0].length + BODY_MENTION_CONTEXT)
    out.push({
      before: body.slice(start, match.index),
      match: match[0],
      after: body.slice(match.index + match[0].length, end),
      offset: match.index,
      hasMore: start > 0,
      hasMoreAfter: end < body.length,
    })
  }
  return out
}

// Bold every occurrence in `text` of any name in `names`, except `selfName`.
// Each <strong> is tagged with `data-mention-offset` so the rail can find
// and scroll to a specific occurrence when a body-mention snippet is clicked.
export function highlightMentions(
  text: string,
  names: ReadonlySet<string>,
  selfName: string,
): ReactNode {
  if (!text) return text
  const re = buildMentionPattern(names, selfName)
  if (!re) return text

  const out: ReactNode[] = []
  let lastIdx = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIdx) out.push(text.slice(lastIdx, match.index))
    out.push(
      <strong
        key={`m${match.index}`}
        className="relmap-rail-mention"
        data-mention-offset={match.index}
      >
        {match[0]}
      </strong>,
    )
    lastIdx = re.lastIndex
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx))
  return <Fragment>{out}</Fragment>
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

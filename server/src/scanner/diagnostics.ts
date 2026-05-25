// LOC-95: informational diagnostics on artifact bodies.
//
// Different from health: health says "this is broken." Diagnostics say
// "you might want to look at this." No score impact, separate UI surface.
//
// v1 ships rule #1 only:
//   - slash-in-path — body has `<word-or-slash-or-colon>/<known-artifact-name>`,
//     i.e. a slash embedded in a path or namespace where the LOC-94 fix
//     correctly rejects it as a "confirmed" command reference. The user
//     probably meant to invoke the command — surface the suggestion.
//
// Rules #2 and #3 (skill-shaped name without slash, plain-word artifact
// in body) are deferred. They have higher false-positive rates and need
// design work before shipping.

export type DiagnosticKind = 'slash-in-path'

export interface Diagnostic {
  kind: DiagnosticKind
  /** Byte offset in `body` of the captured artifact name (not the
   *  preceding boundary char). Lets the UI scroll to the exact spot. */
  offset: number
  /** The full matched substring, e.g. "gsd:planner/accessibility" — kept
   *  so the UI can render the context without re-reading the body. */
  matched: string
  /** The artifact name involved (the slug after the embedded slash). */
  artifactName: string
  /** Human-readable explanation the UI can render verbatim. */
  suggestion: string
}

// Zero-width lookbehind so consecutive embedded slashes are each evaluated
// independently. A consuming `[\w/:-]` would eat the boundary char of the
// next potential match (e.g. `path/to/feedback` would match `to` and miss
// `feedback`). Lookbehind mirrors the shape LOC-94 rejects.
const AMBIGUOUS_SLASH_RE = /(?<=[\w/:-])\/([a-zA-Z][a-zA-Z0-9_-]*(?::[a-zA-Z][a-zA-Z0-9_-]*)?)/g

const CONTEXT_CHARS = 20

export function extractDiagnostics(
  skill: { name: string; body: string },
  allNames: Set<string>,
): Diagnostic[] {
  if (!skill.body) return []
  const out: Diagnostic[] = []
  AMBIGUOUS_SLASH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = AMBIGUOUS_SLASH_RE.exec(skill.body)) !== null) {
    const artifactName = m[1]
    if (artifactName === skill.name) continue           // no self-reference
    if (!allNames.has(artifactName)) continue           // only flag real artifacts
    // Reconstruct a context window: a few chars before the `/` plus the
    // full match. Lets the UI show "…path/to/feedback" without the caller
    // having to re-read the body.
    const ctxStart = Math.max(0, m.index - CONTEXT_CHARS)
    const matched = skill.body.slice(ctxStart, m.index + m[0].length)
    out.push({
      kind: 'slash-in-path',
      offset: m.index,                                  // points at the `/`
      matched,
      artifactName,
      suggestion: `/${artifactName} appears embedded in a longer string. If you meant to invoke the ${artifactName} command, write it on its own line as /${artifactName}.`,
    })
  }
  return out
}

// Lightweight Levenshtein impl. Used by the command detector (LOC-74) to
// merge near-duplicate user prompts. Two-row DP — O(n·m) time, O(min(n,m))
// space, which is fine for the prompt lengths we handle (typically <2000
// chars). No external dependency.

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  // Ensure b is the shorter string so the inner loop and the work-row are
  // sized to the smaller dimension.
  let s = a
  let t = b
  if (t.length > s.length) {
    const tmp = s
    s = t
    t = tmp
  }

  const m = t.length
  let prev = new Array<number>(m + 1)
  let curr = new Array<number>(m + 1)
  for (let j = 0; j <= m; j++) prev[j] = j

  for (let i = 1; i <= s.length; i++) {
    curr[0] = i
    for (let j = 1; j <= m; j++) {
      const cost = s.charCodeAt(i - 1) === t.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(
        curr[j - 1] + 1,    // insertion
        prev[j] + 1,        // deletion
        prev[j - 1] + cost, // substitution
      )
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[m]
}

/** Distance normalized to [0, 1] by max length. 0 = identical, 1 = nothing in common. */
export function normalizedLevenshtein(a: string, b: string): number {
  const max = Math.max(a.length, b.length)
  if (max === 0) return 0
  return levenshtein(a, b) / max
}

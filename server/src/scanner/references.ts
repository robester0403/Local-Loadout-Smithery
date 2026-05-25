export type ReferenceSource = 'body' | 'command' | 'frontmatter'

export interface SkillReference {
  name: string
  source: ReferenceSource
}

export function extractReferences(
  skill: { name: string; body: string; frontmatter: Record<string, unknown> },
  allNames: Set<string>,
): SkillReference[] {
  const refs: SkillReference[] = []
  const seen = new Set<string>()

  function add(name: string, source: ReferenceSource) {
    if (name === skill.name) return  // no self-references
    if (seen.has(name)) return
    seen.add(name)
    refs.push({ name, source })
  }

  // (a) frontmatter `related:` array
  const related = skill.frontmatter['related']
  if (Array.isArray(related)) {
    for (const r of related) {
      if (typeof r === 'string' && allNames.has(r)) add(r, 'frontmatter')
    }
  }

  // (b) /command-name patterns — match `/word` or `/word:subword`
  const cmdRe = /\/([a-zA-Z][a-zA-Z0-9_-]*(?::[a-zA-Z][a-zA-Z0-9_-]*)?)/g
  let m: RegExpExecArray | null
  while ((m = cmdRe.exec(skill.body)) !== null) {
    const name = m[1]
    if (allNames.has(name)) add(name, 'command')
  }

  // (c) skill names mentioned in body — case-insensitive whole-word match.
  // Gated on isSkillShaped (LOC-91): only count names that LOOK like a skill
  // identifier — kebab-case, snake_case, or camelCase. Plain single-word
  // names like "review" or "plan" would otherwise auto-link from every doc
  // that uses the English word in prose, producing phantom edges in the
  // relationship map. Such names still link via explicit (a) frontmatter or
  // (b) /name syntax — both unambiguous author signals.
  // Build a sorted list (longest first to avoid prefix false-positives).
  const sortedNames = Array.from(allNames)
    .filter(isSkillShaped)
    .sort((a, b) => b.length - a.length)
  for (const n of sortedNames) {
    if (n === skill.name) continue
    // Whole-word, case-insensitive
    const re = new RegExp(`(?<![a-zA-Z0-9_-])${escapeRegex(n)}(?![a-zA-Z0-9_-])`, 'i')
    if (re.test(skill.body)) add(n, 'body')
  }

  return refs
}

/** A name qualifies for body-prose matching only if it's typographically
 *  distinctive: contains a hyphen (kebab-case), an underscore (snake_case),
 *  or has a lowercase → uppercase transition (camelCase). Plain single-word
 *  names are too risky because they collide with English prose. */
export function isSkillShaped(name: string): boolean {
  if (name.includes('-')) return true
  if (name.includes('_')) return true
  if (/[a-z][A-Z]/.test(name)) return true
  return false
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

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

  // (c) skill names mentioned in body — case-insensitive whole-word match
  // Build a sorted list (longest first to avoid prefix false-positives)
  const sortedNames = Array.from(allNames).sort((a, b) => b.length - a.length)
  for (const n of sortedNames) {
    if (n === skill.name) continue
    // Whole-word, case-insensitive
    const re = new RegExp(`(?<![a-zA-Z0-9_-])${escapeRegex(n)}(?![a-zA-Z0-9_-])`, 'i')
    if (re.test(skill.body)) add(n, 'body')
  }

  return refs
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

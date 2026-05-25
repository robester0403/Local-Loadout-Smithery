import { describe, it, expect } from 'vitest'
import { extractReferences, isSkillShaped } from '../scanner/references'

function skill(name: string, body: string, frontmatter: Record<string, unknown> = {}) {
  return { name, body, frontmatter }
}

describe('isSkillShaped', () => {
  it('accepts kebab-case', () => {
    expect(isSkillShaped('do-this-task')).toBe(true)
    expect(isSkillShaped('a-b')).toBe(true)
  })
  it('accepts snake_case', () => {
    expect(isSkillShaped('do_this_task')).toBe(true)
  })
  it('accepts camelCase', () => {
    expect(isSkillShaped('formatChangelog')).toBe(true)
    expect(isSkillShaped('aB')).toBe(true)
  })
  it('rejects plain single words regardless of length', () => {
    expect(isSkillShaped('review')).toBe(false)
    expect(isSkillShaped('plan')).toBe(false)
    expect(isSkillShaped('reviewsomething')).toBe(false)
    expect(isSkillShaped('SCREAMING')).toBe(false)
  })
  it('rejects PascalCase without a lower→upper transition', () => {
    // A single capital at the start isn't a transition; this is by design.
    // PascalCase identifiers usually still have an internal transition
    // (FormatChangelog → 'a' → 'C') and pass the check.
    expect(isSkillShaped('Review')).toBe(false)
    expect(isSkillShaped('FormatChangelog')).toBe(true) // 'a' → 'C'
  })
})

describe('extractReferences', () => {
  const allNames = new Set([
    'review', 'plan', 'do-this-task', 'formatChangelog', 'unrelated',
  ])

  it('drops body-match phantom edge for plain word "review" in English prose (LOC-91)', () => {
    const s = skill('helper', 'Please review the changes before merging.')
    const refs = extractReferences(s, allNames)
    expect(refs.find(r => r.name === 'review')).toBeUndefined()
  })

  it('keeps body-match for hyphenated name (do-this-task)', () => {
    const s = skill('helper', 'When ready, invoke do-this-task on the result.')
    const refs = extractReferences(s, allNames)
    expect(refs.find(r => r.name === 'do-this-task' && r.source === 'body')).toBeDefined()
  })

  it('keeps body-match for camelCase name (formatChangelog)', () => {
    const s = skill('helper', 'Use formatChangelog to reformat the file.')
    const refs = extractReferences(s, allNames)
    expect(refs.find(r => r.name === 'formatChangelog' && r.source === 'body')).toBeDefined()
  })

  it('still links plain-word names via explicit /name syntax', () => {
    const s = skill('helper', 'See /review for the next step.')
    const refs = extractReferences(s, allNames)
    expect(refs.find(r => r.name === 'review' && r.source === 'command')).toBeDefined()
  })

  it('still links plain-word names via frontmatter related: array', () => {
    const s = skill('helper', 'unrelated body', { related: ['review', 'plan'] })
    const refs = extractReferences(s, allNames)
    expect(refs.find(r => r.name === 'review' && r.source === 'frontmatter')).toBeDefined()
    expect(refs.find(r => r.name === 'plan' && r.source === 'frontmatter')).toBeDefined()
  })

  it('does not self-reference even when the name is skill-shaped', () => {
    const s = skill('do-this-task', 'do-this-task does its job here')
    const refs = extractReferences(s, allNames)
    expect(refs.find(r => r.name === 'do-this-task')).toBeUndefined()
  })

  it('deduplicates: a single edge per referenced name even when matched by multiple strategies', () => {
    const s = skill('helper', 'See /do-this-task — also do-this-task in prose.', { related: ['do-this-task'] })
    const refs = extractReferences(s, allNames)
    const hits = refs.filter(r => r.name === 'do-this-task')
    expect(hits).toHaveLength(1)
    // First strategy wins (frontmatter is checked first)
    expect(hits[0].source).toBe('frontmatter')
  })

  it('ignores body word that just happens to contain a hyphenated name as a substring', () => {
    // Whole-word boundary guard — "pre-do-this-task-suffix" should NOT match
    // do-this-task because there's a hyphen on either side.
    const s = skill('helper', 'See pre-do-this-task-suffix for context.')
    const refs = extractReferences(s, allNames)
    expect(refs.find(r => r.name === 'do-this-task')).toBeUndefined()
  })

  // LOC-94: slash-prefix regex must require a real word boundary before `/`.
  // Embedded slashes (paths, URLs, namespaces) are NOT command invocations.
  describe('slash-prefix command boundary (LOC-94)', () => {
    it('matches /name at start of body', () => {
      const s = skill('helper', '/review next step')
      const refs = extractReferences(s, allNames)
      expect(refs.find(r => r.name === 'review' && r.source === 'command')).toBeDefined()
    })

    it('matches /name after whitespace', () => {
      const s = skill('helper', 'Then run /plan to continue.')
      const refs = extractReferences(s, allNames)
      expect(refs.find(r => r.name === 'plan' && r.source === 'command')).toBeDefined()
    })

    it('matches /name after punctuation like ( and backtick', () => {
      const s = skill('helper', 'See (/review) and `/plan` for examples.')
      const refs = extractReferences(s, allNames)
      expect(refs.find(r => r.name === 'review' && r.source === 'command')).toBeDefined()
      expect(refs.find(r => r.name === 'plan' && r.source === 'command')).toBeDefined()
    })

    it('does NOT match /name inside a filesystem-like path', () => {
      const s = skill('helper', 'See path/to/review for context.')
      const refs = extractReferences(s, allNames)
      expect(refs.find(r => r.name === 'review' && r.source === 'command')).toBeUndefined()
    })

    it('does NOT match /name after a namespace colon (gsd:planner/review)', () => {
      const s = skill('helper', 'Walk through gsd:planner/review during onboarding.')
      const refs = extractReferences(s, allNames)
      expect(refs.find(r => r.name === 'review' && r.source === 'command')).toBeUndefined()
    })

    it('does NOT match /name inside a URL', () => {
      const s = skill('helper', 'Read https://example.com/review for context.')
      const refs = extractReferences(s, allNames)
      expect(refs.find(r => r.name === 'review' && r.source === 'command')).toBeUndefined()
    })

    it('does NOT match /name when preceded by another identifier char (foo/review)', () => {
      const s = skill('helper', 'name/review/suffix is not a command.')
      const refs = extractReferences(s, allNames)
      expect(refs.find(r => r.name === 'review' && r.source === 'command')).toBeUndefined()
    })

    it('matches /namespace:name correctly at a word boundary', () => {
      const allNamesWithNs = new Set([...allNames, 'gsd:debug'])
      const s = skill('helper', 'Use /gsd:debug to start a session.')
      const refs = extractReferences(s, allNamesWithNs)
      expect(refs.find(r => r.name === 'gsd:debug' && r.source === 'command')).toBeDefined()
    })
  })
})

import { describe, it, expect } from 'vitest'
import { extractDiagnostics } from '../scanner/diagnostics'

function skill(name: string, body: string) {
  return { name, body }
}

describe('extractDiagnostics (LOC-95)', () => {
  const allNames = new Set([
    'accessibility', 'feedback', 'plan', 'review',
    'do-this-task', 'formatChangelog',
    'gsd:debug',
  ])

  it('returns empty for clean bodies', () => {
    const out = extractDiagnostics(skill('helper', 'no slashes or paths here at all'), allNames)
    expect(out).toEqual([])
  })

  it('returns empty when body is missing', () => {
    const out = extractDiagnostics(skill('helper', ''), allNames)
    expect(out).toEqual([])
  })

  it('flags slash-in-path for known artifact name', () => {
    const body = 'Walk through gsd:planner/accessibility next.'
    const out = extractDiagnostics(skill('gsdPlanner', body), allNames)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('slash-in-path')
    expect(out[0].artifactName).toBe('accessibility')
    expect(out[0].matched).toContain('/accessibility')
    expect(out[0].matched).toContain('planner')                 // includes prefix context
    expect(out[0].suggestion).toContain('/accessibility')
    expect(body[out[0].offset]).toBe('/')                       // offset points at the slash
  })

  it('flags filesystem-path-style slashes', () => {
    const out = extractDiagnostics(skill('helper', 'See path/to/feedback for context.'), allNames)
    expect(out).toHaveLength(1)
    expect(out[0].artifactName).toBe('feedback')
  })

  it('flags URL slashes', () => {
    const out = extractDiagnostics(skill('helper', 'Read https://example.com/review for details.'), allNames)
    expect(out).toHaveLength(1)
    expect(out[0].artifactName).toBe('review')
  })

  it('does NOT flag standalone /name at a real word boundary', () => {
    // These ARE real command invocations — references.ts handles them as
    // confirmed; we must not double-surface them as diagnostics.
    const out = extractDiagnostics(skill('helper', 'Use /review and /plan to start.'), allNames)
    expect(out).toEqual([])
  })

  it('does NOT flag when the slug after the embedded slash is NOT a real artifact', () => {
    const out = extractDiagnostics(skill('helper', 'see path/to/unknownThing in the code'), allNames)
    expect(out).toEqual([])
  })

  it('does NOT self-reference', () => {
    const out = extractDiagnostics(skill('accessibility', 'see foo/accessibility for self-link'), allNames)
    expect(out).toEqual([])
  })

  it('reports multiple distinct occurrences', () => {
    const out = extractDiagnostics(skill('helper', 'first path/feedback then later gsd:planner/review'), allNames)
    expect(out).toHaveLength(2)
    expect(out.map(d => d.artifactName).sort()).toEqual(['feedback', 'review'])
  })

  it('reports offsets pointing at the leading slash', () => {
    const body = 'lead in then path/feedback tail'
    const out = extractDiagnostics(skill('helper', body), allNames)
    expect(out).toHaveLength(1)
    expect(body.slice(out[0].offset, out[0].offset + '/feedback'.length)).toBe('/feedback')
  })

  it('handles namespaced artifact names (gsd:debug)', () => {
    const out = extractDiagnostics(skill('helper', 'see path/gsd:debug for example'), allNames)
    expect(out).toHaveLength(1)
    expect(out[0].artifactName).toBe('gsd:debug')
  })
})

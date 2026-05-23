import { describe, it, expect } from 'vitest'
import { validateBundleInput } from '../superRouter/validate'
import type { Skill } from '../scanner/types'
import type { BundleInput } from '../superRouter/types'

function skill(id: string, filePath: string, opts: Partial<Skill> = {}): Skill {
  return {
    id,
    name: id,
    description: 'A nonempty source description.',
    version: '1.0.0',
    type: 'skill',
    scope: 'global',
    account: 'default',
    path: filePath,
    realpath: filePath,
    isSymlink: false,
    body: '',
    bodyBytes: 0,
    bodyTokens: 0,
    listingBytes: 0,
    listingTokens: 0,
    frontmatter: {},
    lastModified: '2026-01-01T00:00:00.000Z',
    health: { status: 'ok', issues: [] },
    disabled: false,
    references: [],
    ...opts,
  }
}

const baseInput: BundleInput = {
  name: 'My bundle',
  target: 'claude',
  scope: { kind: 'global' },
  trigger: 'When user does X.',
  skills: [{ id: 's1' }],
}

describe('validateBundleInput', () => {
  it('passes a well-formed global bundle (source description present)', () => {
    const errs = validateBundleInput(baseInput, [skill('s1', '/anywhere/SKILL.md')])
    expect(errs).toEqual([])
  })

  it('rejects empty name', () => {
    const errs = validateBundleInput({ ...baseInput, name: '   ' }, [skill('s1', '/x/SKILL.md')])
    expect(errs.find(e => e.field === 'name')).toBeDefined()
  })

  it('rejects empty trigger', () => {
    const errs = validateBundleInput({ ...baseInput, trigger: '' }, [skill('s1', '/x/SKILL.md')])
    expect(errs.find(e => e.field === 'trigger')).toBeDefined()
  })

  it('rejects empty skills', () => {
    const errs = validateBundleInput({ ...baseInput, skills: [] }, [])
    expect(errs.find(e => e.field === 'skills')).toBeDefined()
  })

  it('rejects skills that no longer exist in inventory', () => {
    const errs = validateBundleInput(
      { ...baseInput, skills: [{ id: 'ghost' }] },
      [skill('other', '/o/SKILL.md')],
    )
    const err = errs.find(e => e.message.includes('no longer exist'))
    expect(err?.offendingSkillIds).toEqual(['ghost'])
  })

  it('project scope: rejects skills not under the project path', () => {
    const project = '/Users/me/projects/alpha'
    const inProject = skill('a', `${project}/.claude/skills/foo/SKILL.md`)
    const outOfProject = skill('b', '/Users/me/.claude/skills/bar/SKILL.md')
    const errs = validateBundleInput(
      {
        ...baseInput,
        scope: { kind: 'project', path: project },
        skills: [{ id: 'a' }, { id: 'b' }],
      },
      [inProject, outOfProject],
    )
    const err = errs.find(e => e.message.includes('not located under'))
    expect(err?.offendingSkillIds).toEqual(['b'])
  })

  it('project scope: passes when all skills live under the project', () => {
    const project = '/Users/me/projects/alpha'
    const errs = validateBundleInput(
      {
        ...baseInput,
        scope: { kind: 'project', path: project },
        skills: [{ id: 'a' }],
      },
      [skill('a', `${project}/.claude/skills/foo/SKILL.md`)],
    )
    expect(errs).toEqual([])
  })

  it('requires a per-bundle description when the source has none (e.g. commands)', () => {
    const cmd = skill('cmd1', '/path/commands/cmd1.md', {
      type: 'command',
      description: '',
    })
    const errs = validateBundleInput(
      { ...baseInput, skills: [{ id: 'cmd1' }] },
      [cmd],
    )
    const err = errs.find(e => e.message.includes('when to use'))
    expect(err?.offendingSkillIds).toEqual(['cmd1'])
  })

  it('passes when the user fills in a description for a descriptionless source', () => {
    const cmd = skill('cmd1', '/path/commands/cmd1.md', {
      type: 'command',
      description: '',
    })
    const errs = validateBundleInput(
      { ...baseInput, skills: [{ id: 'cmd1', description: 'Use when iterating on integrations.' }] },
      [cmd],
    )
    expect(errs).toEqual([])
  })

  it('passes a well-formed bundle with target="cursor"', () => {
    const errs = validateBundleInput(
      { ...baseInput, target: 'cursor' },
      [skill('s1', '/anywhere/SKILL.md')],
    )
    expect(errs).toEqual([])
  })

  it('passes a well-formed bundle with target="codex"', () => {
    const errs = validateBundleInput(
      { ...baseInput, target: 'codex' },
      [skill('s1', '/anywhere/SKILL.md')],
    )
    expect(errs).toEqual([])
  })

  it('rejects an unknown target', () => {
    const errs = validateBundleInput(
      { ...baseInput, target: 'aider' as BundleInput['target'] },
      [skill('s1', '/anywhere/SKILL.md')],
    )
    const err = errs.find(e => e.field === 'target')
    expect(err).toBeDefined()
    expect(err?.message).toContain('"claude"')
  })
})

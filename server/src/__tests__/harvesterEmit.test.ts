import { describe, it, expect } from 'vitest'
import { __test } from '../harvester/emit'

describe('sanitizeName', () => {
  it('lowercases, kebab-cases, strips junk', () => {
    expect(__test.sanitizeName('My Skill Name!')).toBe('my-skill-name')
  })
  it('throws on empty after sanitization', () => {
    expect(() => __test.sanitizeName('!!!')).toThrow()
  })
})

describe('renderFile', () => {
  it('includes name + description frontmatter and body', () => {
    const out = __test.renderFile({
      accountDir: '/x/.claude', scope: 'global', name: 'My Skill',
      description: 'When to use this.', body: 'Body content.', type: 'skill',
    })
    expect(out).toContain('---')
    expect(out).toContain('name: my-skill')
    expect(out).toContain('description:')
    expect(out).toContain('Body content.')
  })

  it('quotes descriptions with YAML-special characters', () => {
    const out = __test.renderFile({
      accountDir: '/x/.claude', scope: 'global', name: 'X',
      description: 'When: the user says "hello".', body: '', type: 'skill',
    })
    expect(out).toMatch(/description: ".*"/)
  })
})

describe('destinationPath', () => {
  it('places skills under <account>/skills/<slug>/SKILL.md (global)', () => {
    const p = __test.destinationPath({
      accountDir: '/h/.claude', scope: 'global', name: 'foo bar', body: '', description: '', type: 'skill',
    })
    expect(p).toBe('/h/.claude/skills/foo-bar/SKILL.md')
  })

  it('places commands under <account>/commands/<slug>.md', () => {
    const p = __test.destinationPath({
      accountDir: '/h/.claude', scope: 'global', name: 'cmd', body: '', description: '', type: 'command',
    })
    expect(p).toBe('/h/.claude/commands/cmd.md')
  })

  it('places subagents under <account>/agents/<slug>.md', () => {
    const p = __test.destinationPath({
      accountDir: '/h/.claude', scope: 'global', name: 'ag', body: '', description: '', type: 'subagent',
    })
    expect(p).toBe('/h/.claude/agents/ag.md')
  })

  it('project scope uses <project>/.claude/ regardless of account', () => {
    const p = __test.destinationPath({
      accountDir: '/h/.claude', scope: 'project', projectPath: '/proj', name: 'x', body: '', description: '', type: 'skill',
    })
    expect(p).toBe('/proj/.claude/skills/x/SKILL.md')
  })
})

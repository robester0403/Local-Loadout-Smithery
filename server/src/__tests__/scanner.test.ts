import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { findAccounts, accountLabel, discoverAllSkills } from '../scanner/discover'

let tmp: string

function write(p: string, content: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-scanner-'))
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('accountLabel', () => {
  it('returns "default" for .claude dir', () => {
    expect(accountLabel('/home/user/.claude')).toBe('default')
  })

  it('strips .claude- prefix for named accounts', () => {
    expect(accountLabel('/home/user/.claude-work')).toBe('work')
    expect(accountLabel('/home/user/.claude-account-personal')).toBe('account-personal')
  })
})

describe('findAccounts', () => {
  it('finds dirs with settings.json', () => {
    const fakeHome = path.join(tmp, 'home-accounts')
    write(path.join(fakeHome, '.claude', 'settings.json'), '{}')
    write(path.join(fakeHome, '.claude-work', 'settings.json'), '{}')
    write(path.join(fakeHome, '.claude-nope', 'NOT-settings.txt'), '')
    write(path.join(fakeHome, '.claude.json'), '{}') // file, not dir — skip

    // Patch os.homedir temporarily
    const orig = process.env['HOME']
    process.env['HOME'] = fakeHome
    const accounts = findAccounts()
    process.env['HOME'] = orig

    const bases = accounts.map(a => path.basename(a))
    expect(bases).toContain('.claude')
    expect(bases).toContain('.claude-work')
    expect(bases).not.toContain('.claude-nope')
  })
})

describe('discoverAllSkills (fixture)', () => {
  let fixtureHome: string

  beforeAll(() => {
    fixtureHome = path.join(tmp, 'fixture-home')

    // Global skill
    write(
      path.join(fixtureHome, '.claude', 'settings.json'),
      '{}'
    )
    write(
      path.join(fixtureHome, '.claude', 'skills', 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\ndescription: a test skill\n---\nSkill body.\n'
    )

    // Global command (direct .md)
    write(
      path.join(fixtureHome, '.claude', 'commands', 'my-cmd.md'),
      '---\nname: my-cmd\ndescription: a command\n---\nCmd body.\n'
    )

    // Namespaced command
    write(
      path.join(fixtureHome, '.claude', 'commands', 'ns', 'sub-cmd.md'),
      '---\ndescription: namespaced\n---\nNs body.\n'
    )

    // Global agent
    write(
      path.join(fixtureHome, '.claude', 'agents', 'my-agent.md'),
      '---\nname: my-agent\ndescription: an agent\n---\nAgent body.\n'
    )

    // Project-local skill
    write(
      path.join(fixtureHome, '.claude', 'projects', 'proj-abc', 'skills', 'proj-skill', 'SKILL.md'),
      '---\nname: proj-skill\ndescription: project skill\n---\nProj body.\n'
    )
  })

  it('discovers all skill types from fixture', () => {
    const orig = process.env['HOME']
    process.env['HOME'] = fixtureHome
    const skills = discoverAllSkills()
    process.env['HOME'] = orig

    const byName = Object.fromEntries(skills.map(s => [s.name, s]))

    expect(byName['my-skill']).toBeDefined()
    expect(byName['my-skill'].type).toBe('skill')
    expect(byName['my-skill'].scope).toBe('global')
    expect(byName['my-skill'].account).toBe('default')

    expect(byName['my-cmd']).toBeDefined()
    expect(byName['my-cmd'].type).toBe('command')

    expect(byName['ns:sub-cmd']).toBeDefined()
    expect(byName['ns:sub-cmd'].type).toBe('command')

    expect(byName['my-agent']).toBeDefined()
    expect(byName['my-agent'].type).toBe('agent')

    expect(byName['proj-skill']).toBeDefined()
    expect(byName['proj-skill'].scope).toBe('project')
    expect(byName['proj-skill'].projectId).toBe('proj-abc')
  })

  it('deduplicates symlinked skills', () => {
    const dedupeHome = path.join(tmp, 'dedupe-home')
    write(path.join(dedupeHome, '.claude', 'settings.json'), '{}')

    const realDir = path.join(dedupeHome, '.claude', 'skills', 'real-skill')
    fs.mkdirSync(realDir, { recursive: true })
    fs.writeFileSync(
      path.join(realDir, 'SKILL.md'),
      '---\nname: real-skill\ndescription: real\n---\nBody.\n'
    )

    // Create a symlink pointing to the same file
    const linkDir = path.join(dedupeHome, '.claude', 'skills', 'link-skill')
    fs.mkdirSync(linkDir, { recursive: true })
    try {
      fs.symlinkSync(
        path.join(realDir, 'SKILL.md'),
        path.join(linkDir, 'SKILL.md')
      )
    } catch {
      // symlink may fail in some CI environments; skip dedup test
      return
    }

    const orig = process.env['HOME']
    process.env['HOME'] = dedupeHome
    const skills = discoverAllSkills()
    process.env['HOME'] = orig

    // Both the real file and the symlink resolve to the same realpath — dedup keeps exactly one
    const matching = skills.filter(s => s.name === 'real-skill')
    expect(matching.length).toBe(1)
  })

  it('discovers .disabled files as disabled: true with stable id', () => {
    const disabledHome = path.join(tmp, 'disabled-home')
    write(path.join(disabledHome, '.claude', 'settings.json'), '{}')

    // Disabled skill
    write(
      path.join(disabledHome, '.claude', 'skills', 'off-skill', 'SKILL.md.disabled'),
      '---\nname: off-skill\ndescription: a disabled skill\n---\nBody.\n'
    )
    // Disabled command
    write(
      path.join(disabledHome, '.claude', 'commands', 'off-cmd.md.disabled'),
      '---\nname: off-cmd\ndescription: a disabled command\n---\nBody.\n'
    )
    // Disabled agent
    write(
      path.join(disabledHome, '.claude', 'agents', 'off-agent.md.disabled'),
      '---\nname: off-agent\ndescription: a disabled agent\n---\nBody.\n'
    )

    const orig = process.env['HOME']
    process.env['HOME'] = disabledHome
    const skills = discoverAllSkills()
    process.env['HOME'] = orig

    const byName = Object.fromEntries(skills.map(s => [s.name, s]))

    expect(byName['off-skill']).toBeDefined()
    expect(byName['off-skill'].disabled).toBe(true)
    expect(byName['off-skill'].path).not.toContain('.disabled')

    expect(byName['off-cmd']).toBeDefined()
    expect(byName['off-cmd'].disabled).toBe(true)
    expect(byName['off-cmd'].path).not.toContain('.disabled')

    expect(byName['off-agent']).toBeDefined()
    expect(byName['off-agent'].disabled).toBe(true)
    expect(byName['off-agent'].path).not.toContain('.disabled')

    // ID must be stable — same as what the enabled file would produce
    const expectedSkillPath = path.join(disabledHome, '.claude', 'skills', 'off-skill', 'SKILL.md')
    expect(byName['off-skill'].id).toBe(Buffer.from(expectedSkillPath).toString('base64'))
  })

  it('returns empty array when account has no skills', () => {
    const emptyHome = path.join(tmp, 'empty-home')
    write(path.join(emptyHome, '.claude', 'settings.json'), '{}')

    const orig = process.env['HOME']
    process.env['HOME'] = emptyHome
    const skills = discoverAllSkills()
    process.env['HOME'] = orig

    expect(skills).toEqual([])
  })
})

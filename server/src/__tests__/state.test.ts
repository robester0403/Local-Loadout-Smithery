import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { disableSkill, enableSkill } from '../state/index'

// decodePath enforces that paths must be under os.homedir().
// We create our tmp fixtures directly under $HOME so that constraint is satisfied.
let tmp: string

function skillId(filePath: string): string {
  return Buffer.from(filePath).toString('base64')
}

function write(p: string, content = '---\nname: test\ndescription: a test skill\n---\nBody.\n') {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf-8')
}

beforeEach(() => {
  // Create tmp dir under $HOME so isUnderHome() passes
  tmp = fs.mkdtempSync(path.join(os.homedir(), '.lsm-state-test-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// disableSkill
// ---------------------------------------------------------------------------

describe('disableSkill', () => {
  it('renames SKILL.md to SKILL.md.disabled', () => {
    const skillPath = path.join(tmp, '.claude', 'skills', 'my-skill', 'SKILL.md')
    write(skillPath)

    disableSkill(skillId(skillPath))

    expect(fs.existsSync(skillPath)).toBe(false)
    expect(fs.existsSync(skillPath + '.disabled')).toBe(true)
  })

  it('renames a command .md to .md.disabled', () => {
    const cmdPath = path.join(tmp, '.claude', 'commands', 'my-cmd.md')
    write(cmdPath)

    disableSkill(skillId(cmdPath))

    expect(fs.existsSync(cmdPath)).toBe(false)
    expect(fs.existsSync(cmdPath + '.disabled')).toBe(true)
  })

  it('renames a subagent .md to .md.disabled', () => {
    const agentPath = path.join(tmp, '.claude', 'agents', 'my-agent.md')
    write(agentPath)

    disableSkill(skillId(agentPath))

    expect(fs.existsSync(agentPath)).toBe(false)
    expect(fs.existsSync(agentPath + '.disabled')).toBe(true)
  })

  it('is idempotent — double-disable does not throw', () => {
    const skillPath = path.join(tmp, '.claude', 'skills', 'dupe-skill', 'SKILL.md')
    write(skillPath)

    disableSkill(skillId(skillPath))
    // Calling again on the same id (original path) should not throw
    expect(() => disableSkill(skillId(skillPath))).not.toThrow()
    // File is still in disabled state
    expect(fs.existsSync(skillPath + '.disabled')).toBe(true)
  })

  it('throws a descriptive error for a non-existent skill', () => {
    const missingPath = path.join(tmp, '.claude', 'skills', 'ghost', 'SKILL.md')

    expect(() => disableSkill(skillId(missingPath))).toThrowError(/Skill file not found/)
  })

  it('preserves file content after disable', () => {
    const skillPath = path.join(tmp, '.claude', 'skills', 'content-skill', 'SKILL.md')
    const content = '---\nname: content-skill\ndescription: testing content preservation\n---\nHello world.\n'
    write(skillPath, content)

    disableSkill(skillId(skillPath))

    const written = fs.readFileSync(skillPath + '.disabled', 'utf-8')
    expect(written).toBe(content)
  })
})

// ---------------------------------------------------------------------------
// enableSkill
// ---------------------------------------------------------------------------

describe('enableSkill', () => {
  it('renames SKILL.md.disabled back to SKILL.md', () => {
    const skillPath = path.join(tmp, '.claude', 'skills', 're-skill', 'SKILL.md')
    write(skillPath)

    disableSkill(skillId(skillPath))
    enableSkill(skillId(skillPath))

    expect(fs.existsSync(skillPath)).toBe(true)
    expect(fs.existsSync(skillPath + '.disabled')).toBe(false)
  })

  it('re-enables a disabled command', () => {
    const cmdPath = path.join(tmp, '.claude', 'commands', 're-cmd.md')
    write(cmdPath)

    disableSkill(skillId(cmdPath))
    enableSkill(skillId(cmdPath))

    expect(fs.existsSync(cmdPath)).toBe(true)
    expect(fs.existsSync(cmdPath + '.disabled')).toBe(false)
  })

  it('re-enables a disabled subagent', () => {
    const agentPath = path.join(tmp, '.claude', 'agents', 're-agent.md')
    write(agentPath)

    disableSkill(skillId(agentPath))
    enableSkill(skillId(agentPath))

    expect(fs.existsSync(agentPath)).toBe(true)
    expect(fs.existsSync(agentPath + '.disabled')).toBe(false)
  })

  it('is idempotent — enabling an already-enabled skill does not throw', () => {
    const skillPath = path.join(tmp, '.claude', 'skills', 'always-on', 'SKILL.md')
    write(skillPath)

    // skill is enabled, calling enable again should be a no-op
    expect(() => enableSkill(skillId(skillPath))).not.toThrow()
    expect(fs.existsSync(skillPath)).toBe(true)
  })

  it('throws a descriptive error when neither .md nor .md.disabled exist', () => {
    const missingPath = path.join(tmp, '.claude', 'skills', 'void', 'SKILL.md')

    expect(() => enableSkill(skillId(missingPath))).toThrowError(/not found/)
  })
})

// ---------------------------------------------------------------------------
// State verification — what the scanner relies on
// ---------------------------------------------------------------------------

describe('disable/enable state invariants', () => {
  it('after disableSkill: original path gone, .disabled path exists', () => {
    const skillPath = path.join(tmp, '.claude', 'skills', 'inv-skill', 'SKILL.md')
    write(skillPath)

    disableSkill(skillId(skillPath))

    expect(fs.existsSync(skillPath)).toBe(false)
    expect(fs.existsSync(skillPath + '.disabled')).toBe(true)
  })

  it('after enableSkill: .disabled path gone, original path restored', () => {
    const skillPath = path.join(tmp, '.claude', 'skills', 'inv-skill2', 'SKILL.md')
    write(skillPath)

    disableSkill(skillId(skillPath))
    enableSkill(skillId(skillPath))

    expect(fs.existsSync(skillPath + '.disabled')).toBe(false)
    expect(fs.existsSync(skillPath)).toBe(true)
  })

  it('skill id is stable across disable/enable cycles (base64 of original path)', () => {
    const skillPath = path.join(tmp, '.claude', 'skills', 'stable-id', 'SKILL.md')
    write(skillPath)

    const id = skillId(skillPath)

    disableSkill(id)
    enableSkill(id)
    disableSkill(id)

    // After all that, file is disabled and .disabled exists
    expect(fs.existsSync(skillPath + '.disabled')).toBe(true)
  })
})

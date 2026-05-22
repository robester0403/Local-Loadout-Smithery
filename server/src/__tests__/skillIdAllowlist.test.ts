import { describe, it, expect } from 'vitest'
import os from 'os'
import path from 'path'
import { decodeSkillId } from '../lib/ids'

const HOME = os.homedir()
const enc = (p: string) => Buffer.from(p).toString('base64')

describe('decodeSkillId allowlist (LOC-39)', () => {
  it('accepts paths under ~/.claude', () => {
    const p = path.join(HOME, '.claude', 'skills', 'foo', 'SKILL.md')
    expect(decodeSkillId(enc(p))).toBe(p)
  })

  it('accepts paths under a ~/.claude-* variant', () => {
    const p = path.join(HOME, '.claude-work', 'skills', 'foo', 'SKILL.md')
    expect(decodeSkillId(enc(p))).toBe(p)
  })

  it('accepts paths under ~/.cursor', () => {
    const p = path.join(HOME, '.cursor', 'skills', 'foo', 'SKILL.md')
    expect(decodeSkillId(enc(p))).toBe(p)
  })

  it('accepts paths under ~/.codex', () => {
    const p = path.join(HOME, '.codex', 'AGENTS.md')
    expect(decodeSkillId(enc(p))).toBe(p)
  })

  it('accepts project-scoped Codex AGENTS.md outside known loadout dirs', () => {
    const p = path.join(HOME, 'projects', 'my-app', 'AGENTS.md')
    expect(decodeSkillId(enc(p))).toBe(p)
  })

  it('accepts paths under ~/.loadoutsmith (trash, baselines, versions)', () => {
    const p = path.join(HOME, '.loadoutsmith', 'uninstalled', 'abc', 'SKILL.md')
    expect(decodeSkillId(enc(p))).toBe(p)
  })

  it('rejects ~/.ssh/id_rsa', () => {
    const p = path.join(HOME, '.ssh', 'id_rsa')
    expect(() => decodeSkillId(enc(p))).toThrow(/allowed loadout root/)
  })

  it('rejects an arbitrary file in home', () => {
    const p = path.join(HOME, 'Documents', 'notes.txt')
    expect(() => decodeSkillId(enc(p))).toThrow(/allowed loadout root/)
  })

  it('rejects paths outside home', () => {
    expect(() => decodeSkillId(enc('/etc/passwd'))).toThrow(/outside home/)
  })

  it('rejects an empty or non-string id', () => {
    expect(() => decodeSkillId(undefined)).toThrow(/Invalid id/)
    expect(() => decodeSkillId('')).toThrow(/Invalid id/)
  })
})

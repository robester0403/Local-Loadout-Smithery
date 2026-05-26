import { describe, it, expect } from 'vitest'
import {
  decodeBundleSkillPath,
  reconcileBundleSkills,
} from '../superRouter/reconcile'
import type { Skill, SkillType } from '../scanner/types'
import type { BundleSkillEntry } from '../superRouter/types'

const HOME = '/Users/test'

function encode(p: string): string {
  return Buffer.from(p).toString('base64')
}

// Build a minimum-viable Skill row for reconcile testing — all the
// non-identity fields are defaults the reconcile logic doesn't read.
function skill(opts: {
  name: string
  type: SkillType
  account: string
  realpath: string
  description?: string
}): Skill {
  return {
    id: encode(opts.realpath),
    name: opts.name,
    description: opts.description ?? 'desc',
    version: '',
    type: opts.type,
    scope: 'global',
    account: opts.account,
    path: opts.realpath,
    realpath: opts.realpath,
    isSymlink: false,
    body: 'body',
    bodyBytes: 4,
    bodyTokens: 1,
    listingBytes: 10,
    listingTokens: 3,
    frontmatter: {},
    lastModified: '2026-05-25T00:00:00.000Z',
    health: { status: 'ok', issues: [] },
    disabled: false,
    references: [],
    diagnostics: [],
    suggestedType: null,
  }
}

function entry(idPath: string, description?: string): BundleSkillEntry {
  return description ? { id: encode(idPath), description } : { id: encode(idPath) }
}

describe('decodeBundleSkillPath', () => {
  it('decodes a default-account skill path', () => {
    const d = decodeBundleSkillPath(encode(`${HOME}/.claude/skills/morning-plan/SKILL.md`))
    expect(d.name).toBe('morning-plan')
    expect(d.type).toBe('skill')
    expect(d.account).toBe('default')
  })

  it('decodes a named-account skill path', () => {
    const d = decodeBundleSkillPath(encode(`${HOME}/.claude-work/skills/foo/SKILL.md`))
    expect(d.name).toBe('foo')
    expect(d.account).toBe('work')
    expect(d.type).toBe('skill')
  })

  it('decodes a cursor + codex skill path', () => {
    expect(decodeBundleSkillPath(encode(`${HOME}/.cursor/skills/x/SKILL.md`)).account).toBe('cursor')
    expect(decodeBundleSkillPath(encode(`${HOME}/.codex/skills/x/SKILL.md`)).account).toBe('codex')
  })

  it('decodes a command path', () => {
    const d = decodeBundleSkillPath(encode(`${HOME}/.claude/commands/log-job.md`))
    expect(d.name).toBe('log-job')
    expect(d.type).toBe('command')
    expect(d.account).toBe('default')
  })

  it('decodes a namespaced command path', () => {
    const d = decodeBundleSkillPath(encode(`${HOME}/.claude/commands/gsd/plan-phase.md`))
    expect(d.name).toBe('gsd:plan-phase')
    expect(d.type).toBe('command')
  })

  it('decodes a subagent path', () => {
    const d = decodeBundleSkillPath(encode(`${HOME}/.claude/agents/reviewer.md`))
    expect(d.name).toBe('reviewer')
    expect(d.type).toBe('subagent')
  })

  it('decodes a project-scope skill', () => {
    // <cwd>/.claude/skills/<name>/SKILL.md — same offset from the .claude
    // segment, so the decoder works on project-scope paths unchanged.
    const d = decodeBundleSkillPath(encode('/Users/test/proj/.claude/skills/proj-skill/SKILL.md'))
    expect(d.name).toBe('proj-skill')
    expect(d.type).toBe('skill')
    expect(d.account).toBe('default')
  })

  it('returns blanks for an unparseable id', () => {
    const d = decodeBundleSkillPath('not-base64-!@#$')
    expect(d.name).toBe('')
    expect(d.type).toBeNull()
    expect(d.account).toBe('')
  })

  it('returns blanks for a non-loadout path', () => {
    const d = decodeBundleSkillPath(encode('/etc/passwd'))
    expect(d.name).toBe('')
    expect(d.type).toBeNull()
    expect(d.account).toBe('')
  })
})

describe('reconcileBundleSkills', () => {
  it('fast path: every entry resolves — no healed, no decode', () => {
    const live = skill({ name: 'foo', type: 'skill', account: 'default', realpath: `${HOME}/.claude/skills/foo/SKILL.md` })
    const bundle: BundleSkillEntry[] = [{ id: live.id }]

    const r = reconcileBundleSkills(bundle, [live])
    expect(r.resolved).toEqual(bundle)
    expect(r.healed).toEqual([])
    expect(r.missing).toEqual([])
    expect(r.ambiguous).toEqual([])
  })

  it('renamed skill: heals via (name, type, account)', () => {
    // Stored ID points to the OLD path; live skill is at a NEW path with
    // the same logical name.
    const oldPath = `${HOME}/.claude/skills/foo/SKILL.md`
    const newPath = `${HOME}/.claude/skills/foo/SKILL.md` // same name+type+account; realpath shifted via symlink swap
    // Simulate by making the LIVE skill's realpath different from what's
    // stored — change one character so the IDs differ.
    const liveAtNew = skill({ name: 'foo', type: 'skill', account: 'default', realpath: `${HOME}/.claude/skills/foo/SKILL.md.real` })
    const staleEntry: BundleSkillEntry = { id: encode(oldPath), description: 'when foo' }

    const r = reconcileBundleSkills([staleEntry], [liveAtNew])
    expect(r.healed).toHaveLength(1)
    expect(r.healed[0].from).toBe(staleEntry.id)
    expect(r.healed[0].to).toBe(liveAtNew.id)
    expect(r.healed[0].name).toBe('foo')
    expect(r.resolved).toHaveLength(1)
    expect(r.resolved[0].id).toBe(liveAtNew.id)
    // Description override carries through.
    expect(r.resolved[0].description).toBe('when foo')
    expect(r.missing).toEqual([])
    expect(r.ambiguous).toEqual([])
    void newPath // referenced for narrative
  })

  it('reclassified skill: heals across types via (name, account) fallback', () => {
    // User reclassified `foo` from a skill to a command. The stored ID
    // encodes the old skill path; the live inventory only has it as a
    // command.
    const oldPath = `${HOME}/.claude/skills/foo/SKILL.md`
    const liveCmd = skill({ name: 'foo', type: 'command', account: 'default', realpath: `${HOME}/.claude/commands/foo.md` })
    const stale: BundleSkillEntry = { id: encode(oldPath) }

    const r = reconcileBundleSkills([stale], [liveCmd])
    expect(r.healed).toHaveLength(1)
    expect(r.resolved[0].id).toBe(liveCmd.id)
    expect(r.missing).toEqual([])
  })

  it('truly deleted skill: returns in missing, not silently dropped', () => {
    const stale: BundleSkillEntry = { id: encode(`${HOME}/.claude/skills/gone/SKILL.md`) }
    const live = skill({ name: 'other', type: 'skill', account: 'default', realpath: `${HOME}/.claude/skills/other/SKILL.md` })

    const r = reconcileBundleSkills([stale], [live])
    expect(r.healed).toEqual([])
    expect(r.missing).toHaveLength(1)
    expect(r.missing[0].decoded.name).toBe('gone')
    expect(r.resolved).toEqual([])
  })

  it('ambiguous match: returns in ambiguous, not auto-picked', () => {
    // Two skills with the same name+account but different types — primary
    // (name, type, account) lookup will pick one; force ambiguity by also
    // making the type unknown in the encoded path.
    const stalePath = '/Users/test/.claude/skills/dup/SKILL.md'
    const a = skill({ name: 'dup', type: 'skill', account: 'default', realpath: `${HOME}/.claude/skills/dup/SKILL.md.x` })
    const b = skill({ name: 'dup', type: 'command', account: 'default', realpath: `${HOME}/.claude/commands/dup.md` })

    // The decoded type is 'skill' so the primary match returns 1 (a).
    // To trigger ambiguous we'd need 2 skills with the SAME (name,type,account).
    // That's the actual ambiguous case — let's construct it with two
    // skill-typed rows.
    const dup1 = skill({ name: 'dup', type: 'skill', account: 'default', realpath: `${HOME}/.claude/skills/dup/SKILL.md.a` })
    const dup2 = skill({ name: 'dup', type: 'skill', account: 'default', realpath: `${HOME}/.claude/skills/dup/SKILL.md.b` })
    const stale: BundleSkillEntry = { id: encode(stalePath) }

    const r = reconcileBundleSkills([stale], [dup1, dup2])
    expect(r.ambiguous).toHaveLength(1)
    expect(r.ambiguous[0].matches).toHaveLength(2)
    expect(r.healed).toEqual([])
    expect(r.resolved).toEqual([])
    void a; void b
  })

  it('mixed bundle: fast-path + healed + missing in one call', () => {
    const fastSkill = skill({ name: 'fast', type: 'skill', account: 'default', realpath: `${HOME}/.claude/skills/fast/SKILL.md` })
    const healedSkill = skill({ name: 'renamed', type: 'skill', account: 'default', realpath: `${HOME}/.claude/skills/renamed/SKILL.md.new` })
    const bundle: BundleSkillEntry[] = [
      { id: fastSkill.id },                                                         // fast path
      { id: encode(`${HOME}/.claude/skills/renamed/SKILL.md`), description: 'd' },  // heal
      { id: encode(`${HOME}/.claude/skills/gone/SKILL.md`) },                        // missing
    ]

    const r = reconcileBundleSkills(bundle, [fastSkill, healedSkill])
    expect(r.resolved).toHaveLength(2)
    expect(r.resolved[0].id).toBe(fastSkill.id)
    expect(r.resolved[1].id).toBe(healedSkill.id)
    expect(r.resolved[1].description).toBe('d') // override preserved
    expect(r.healed).toHaveLength(1)
    expect(r.missing).toHaveLength(1)
    expect(r.missing[0].decoded.name).toBe('gone')
  })

  it('idempotent: running twice on the same input yields the same shape', () => {
    const liveAtNew = skill({ name: 'foo', type: 'skill', account: 'default', realpath: `${HOME}/.claude/skills/foo/SKILL.md.new` })
    const stale: BundleSkillEntry = { id: encode(`${HOME}/.claude/skills/foo/SKILL.md`) }

    const r1 = reconcileBundleSkills([stale], [liveAtNew])
    // Feed r1.resolved (which has the NEW id) back in — should be fast-path only.
    const r2 = reconcileBundleSkills(r1.resolved, [liveAtNew])

    expect(r2.healed).toEqual([])
    expect(r2.missing).toEqual([])
    expect(r2.resolved).toEqual(r1.resolved)
  })

  it('cross-account: rename in one account does NOT heal from a different account', () => {
    // Bundle references a skill in the "work" account; only a same-named
    // skill exists in "default" — must not heal across accounts.
    const stale: BundleSkillEntry = { id: encode(`${HOME}/.claude-work/skills/foo/SKILL.md`) }
    const wrongAccount = skill({ name: 'foo', type: 'skill', account: 'default', realpath: `${HOME}/.claude/skills/foo/SKILL.md` })

    const r = reconcileBundleSkills([stale], [wrongAccount])
    expect(r.healed).toEqual([])
    expect(r.missing).toHaveLength(1)
    expect(r.missing[0].decoded.account).toBe('work')
  })

  it('unparseable id: classified as missing, not crashed', () => {
    const stale: BundleSkillEntry = { id: 'malformed-not-base64-!!' }
    const live = skill({ name: 'foo', type: 'skill', account: 'default', realpath: `${HOME}/.claude/skills/foo/SKILL.md` })

    const r = reconcileBundleSkills([stale], [live])
    expect(r.missing).toHaveLength(1)
    expect(r.healed).toEqual([])
  })
})

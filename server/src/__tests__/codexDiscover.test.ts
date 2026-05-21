import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { discoverCodexSkills, findCodexProjectCwds } from '../codex/discover'

let tmp: string
let origHome: string | undefined

function writeAgents(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

function writeSession(sessionsDir: string, name: string, lines: object[]): void {
  fs.mkdirSync(sessionsDir, { recursive: true })
  const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n'
  fs.writeFileSync(path.join(sessionsDir, name), content)
}

beforeEach(() => {
  origHome = process.env['HOME']
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsm-codex-test-'))
  process.env['HOME'] = tmp
})

afterEach(() => {
  process.env['HOME'] = origHome
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('discoverCodexSkills', () => {
  it('returns [] when ~/.codex/ has no AGENTS.md and no sessions', () => {
    const codexDir = path.join(tmp, '.codex')
    fs.mkdirSync(codexDir, { recursive: true })
    expect(discoverCodexSkills(codexDir)).toEqual([])
  })

  it('returns the global AGENTS.md as a global skill', () => {
    const codexDir = path.join(tmp, '.codex')
    writeAgents(path.join(codexDir, 'AGENTS.md'), '# Global codex instructions\n\nUse python type hints everywhere.\n')

    const skills = discoverCodexSkills(codexDir)
    expect(skills).toHaveLength(1)
    expect(skills[0].account).toBe('codex')
    expect(skills[0].scope).toBe('global')
    expect(skills[0].type).toBe('skill')
    expect(skills[0].name).toBe('AGENTS')
    expect(skills[0].body).toContain('python type hints')
  })

  it('reads frontmatter description when present', () => {
    const codexDir = path.join(tmp, '.codex')
    writeAgents(
      path.join(codexDir, 'AGENTS.md'),
      `---\ndescription: Codex global instructions for typed Python\n---\n\n# Body\n`,
    )
    const skills = discoverCodexSkills(codexDir)
    expect(skills[0].description).toBe('Codex global instructions for typed Python')
  })

  it('discovers a project AGENTS.md via session cwd metadata', () => {
    const codexDir = path.join(tmp, '.codex')
    const project = path.join(tmp, 'my-project')
    writeAgents(path.join(project, 'AGENTS.md'), 'project instructions\n')
    writeSession(path.join(codexDir, 'sessions'), 'sess-1.jsonl', [
      { cwd: project, model: 'codex-mini', started_at: '2026-05-21T10:00:00Z' },
      { id: '1', role: 'user', content: 'hi', timestamp: '2026-05-21T10:00:01Z' },
    ])

    const skills = discoverCodexSkills(codexDir)
    expect(skills.some(s => s.scope === 'project' && s.account === 'codex' && s.projectId === project)).toBe(true)
  })

  it('reads cwd from a nested meta.cwd shape', () => {
    const codexDir = path.join(tmp, '.codex')
    const project = path.join(tmp, 'nested-meta-project')
    writeAgents(path.join(project, 'AGENTS.md'), 'x\n')
    writeSession(path.join(codexDir, 'sessions'), 'sess-2.jsonl', [
      { meta: { cwd: project, model: 'codex-mini' } },
      { id: '1', role: 'user', content: 'hi', timestamp: '2026-05-21T10:00:01Z' },
    ])

    expect(findCodexProjectCwds(codexDir)).toContain(project)
  })

  it('deduplicates cwds when multiple sessions point at the same project', () => {
    const codexDir = path.join(tmp, '.codex')
    const project = path.join(tmp, 'p')
    writeAgents(path.join(project, 'AGENTS.md'), 'x\n')
    writeSession(path.join(codexDir, 'sessions'), 'sess-a.jsonl', [{ cwd: project }])
    writeSession(path.join(codexDir, 'sessions'), 'sess-b.jsonl', [{ cwd: project }])
    writeSession(path.join(codexDir, 'sessions'), 'sess-c.jsonl', [{ cwd: project }])

    const cwds = findCodexProjectCwds(codexDir)
    expect(cwds.filter(c => c === project)).toHaveLength(1)
  })

  it('skips project cwds whose AGENTS.md does not exist', () => {
    const codexDir = path.join(tmp, '.codex')
    // No AGENTS.md at the project path on purpose.
    writeSession(path.join(codexDir, 'sessions'), 'sess.jsonl', [
      { cwd: path.join(tmp, 'no-agents-here') },
    ])
    const skills = discoverCodexSkills(codexDir)
    expect(skills).toEqual([])
  })

  it('returns both global and project AGENTS.md in a single scan', () => {
    const codexDir = path.join(tmp, '.codex')
    writeAgents(path.join(codexDir, 'AGENTS.md'), 'global\n')
    const project = path.join(tmp, 'proj-x')
    writeAgents(path.join(project, 'AGENTS.md'), 'project\n')
    writeSession(path.join(codexDir, 'sessions'), 'sess.jsonl', [{ cwd: project }])

    const skills = discoverCodexSkills(codexDir)
    expect(skills.filter(s => s.scope === 'global')).toHaveLength(1)
    expect(skills.filter(s => s.scope === 'project')).toHaveLength(1)
  })

  it('uses the project basename as the skill name (not "AGENTS")', () => {
    const codexDir = path.join(tmp, '.codex')
    const project = path.join(tmp, 'cool-app')
    writeAgents(path.join(project, 'AGENTS.md'), 'x\n')
    writeSession(path.join(codexDir, 'sessions'), 'sess.jsonl', [{ cwd: project }])

    const skills = discoverCodexSkills(codexDir)
    const proj = skills.find(s => s.scope === 'project')
    expect(proj?.name).toBe('cool-app')
  })

  it('tolerates malformed JSONL lines without throwing', () => {
    const codexDir = path.join(tmp, '.codex')
    const sessionsDir = path.join(codexDir, 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    fs.writeFileSync(path.join(sessionsDir, 'bad.jsonl'), 'not json\n{also not\n')

    expect(() => discoverCodexSkills(codexDir)).not.toThrow()
    expect(findCodexProjectCwds(codexDir)).toEqual([])
  })
})

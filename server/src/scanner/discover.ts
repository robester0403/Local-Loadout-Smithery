import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseFrontmatter } from '../parser/frontmatter'
import { computeHealth } from './health'
import { extractReferences } from './references'
import { inferType } from './classification'
import { countTokens } from '../usage/tokenizer'
import type { Skill, SkillType, SkillScope, HealthResult } from './types'

// Mirrors the listing budget constraints from loaded.ts.
// Cannot import from there — circular dep (loaded imports discoverAllSkills).
const PER_SKILL_DESC_CAP_BYTES = 1536

function computeListingBytes(name: string, description: string): number {
  const nameBytes = Buffer.byteLength(name, 'utf-8')
  if (nameBytes === 0) return 0
  const descBytes = Math.min(Buffer.byteLength(description, 'utf-8'), PER_SKILL_DESC_CAP_BYTES)
  return nameBytes + 1 + descBytes
}

function computeListingTokens(name: string, description: string): number {
  // Approximate byte-level truncation with char-level slice — fine for ASCII descriptions.
  const truncated = description.slice(0, PER_SKILL_DESC_CAP_BYTES)
  return countTokens(`${name} ${truncated}`.trimEnd())
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function fileExists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

export function findAccounts(): string[] {
  const home = os.homedir()
  const accounts: string[] = []
  let entries: string[]
  try {
    entries = fs.readdirSync(home)
  } catch {
    return accounts
  }

  for (const entry of entries) {
    if (!entry.startsWith('.claude')) continue
    const full = path.join(home, entry)
    try {
      if (!fs.statSync(full).isDirectory()) continue
      // Confirm it's a real account dir by checking for settings.json
      if (!fileExists(path.join(full, 'settings.json'))) continue
      accounts.push(full)
    } catch {
      continue
    }
  }

  // Cursor inhabits a single ~/.cursor/ tree (no multi-account concept like
  // Claude Code's .claude / .claude-work). Cursor doesn't ship a settings.json
  // we can sentinel against, so we instead require at least one of the known
  // skill subdirs to exist before treating the directory as a loadout source.
  const cursorDir = path.join(home, '.cursor')
  try {
    if (fs.statSync(cursorDir).isDirectory()) {
      const hasLoadout = (
        isDir(path.join(cursorDir, 'skills')) ||
        isDir(path.join(cursorDir, 'skills-cursor')) ||
        isDir(path.join(cursorDir, 'commands')) ||
        isDir(path.join(cursorDir, 'agents'))
      )
      if (hasLoadout) accounts.push(cursorDir)
    }
  } catch {
    // .cursor missing or unreadable — fine, just skip.
  }

  return accounts
}

export function accountLabel(accountDir: string): string {
  const base = path.basename(accountDir)
  if (base === '.cursor') return 'cursor'
  return base === '.claude' ? 'default' : base.slice('.claude-'.length)
}

function buildSkill(
  filePath: string,
  type: SkillType,
  scope: SkillScope,
  account: string,
  overrideName?: string,
  projectId?: string,
  disabled = false,
): Skill | null {
  try {
    const { meta, body } = parseFrontmatter(filePath)

    // For disabled files (e.g. SKILL.md.disabled), strip the suffix so the ID
    // is stable across enable/disable cycles.
    const logicalPath = disabled ? filePath.replace(/\.disabled$/, '') : filePath

    let realpath = logicalPath
    let isSymlink = false
    try {
      isSymlink = fs.lstatSync(logicalPath).isSymbolicLink()
      realpath = disabled ? logicalPath : fs.realpathSync(logicalPath)
    } catch {
      // keep defaults
    }

    const stat = fs.statSync(filePath)

    const name =
      overrideName ||
      (meta['name'] as string | undefined) ||
      path.basename(path.dirname(filePath)) ||
      path.basename(logicalPath, '.md')

    const description = (meta['description'] as string | undefined) || ''
    const base: Omit<Skill, 'health' | 'disabled' | 'suggestedType'> = {
      id: Buffer.from(realpath).toString('base64'),
      name,
      description,
      version: (meta['version'] as string | undefined) || '',
      type,
      scope,
      account,
      ...(projectId ? { projectId } : {}),
      path: logicalPath,
      realpath,
      isSymlink,
      body,
      bodyBytes: Buffer.byteLength(body, 'utf-8'),
      bodyTokens: countTokens(body),
      listingBytes: computeListingBytes(name, description),
      listingTokens: computeListingTokens(name, description),
      frontmatter: meta,
      lastModified: stat.mtime.toISOString(),
      references: [],
    }
    const health: HealthResult = computeHealth(base)
    return { ...base, health, disabled, suggestedType: null }
  } catch {
    return null
  }
}

function discoverSkillsDir(
  skillsDir: string,
  scope: SkillScope,
  account: string,
  projectId?: string,
): Skill[] {
  const results: Skill[] = []
  for (const entry of listDir(skillsDir)) {
    const skillFile = path.join(skillsDir, entry, 'SKILL.md')
    const disabledFile = skillFile + '.disabled'
    if (fileExists(skillFile)) {
      const skill = buildSkill(skillFile, 'skill', scope, account, undefined, projectId)
      if (skill) results.push(skill)
    } else if (fileExists(disabledFile)) {
      const skill = buildSkill(disabledFile, 'skill', scope, account, undefined, projectId, true)
      if (skill) results.push(skill)
    }
  }
  return results
}

function discoverCommandsDir(
  commandsDir: string,
  scope: SkillScope,
  account: string,
  projectId?: string,
): Skill[] {
  const results: Skill[] = []
  for (const entry of listDir(commandsDir)) {
    const full = path.join(commandsDir, entry)
    if (entry.endsWith('.md.disabled')) {
      const name = path.basename(entry, '.md.disabled')
      const skill = buildSkill(full, 'command', scope, account, name, projectId, true)
      if (skill) results.push(skill)
    } else if (entry.endsWith('.md')) {
      const name = path.basename(entry, '.md')
      const skill = buildSkill(full, 'command', scope, account, name, projectId)
      if (skill) results.push(skill)
    } else if (isDir(full)) {
      // Namespaced commands: commands/{namespace}/*.md → name = "namespace:command"
      for (const sub of listDir(full)) {
        if (sub.endsWith('.md.disabled')) {
          const subFile = path.join(full, sub)
          const name = `${entry}:${path.basename(sub, '.md.disabled')}`
          const skill = buildSkill(subFile, 'command', scope, account, name, projectId, true)
          if (skill) results.push(skill)
        } else if (sub.endsWith('.md')) {
          const subFile = path.join(full, sub)
          const name = `${entry}:${path.basename(sub, '.md')}`
          const skill = buildSkill(subFile, 'command', scope, account, name, projectId)
          if (skill) results.push(skill)
        }
      }
    }
  }
  return results
}

function discoverAgentsDir(
  agentsDir: string,
  scope: SkillScope,
  account: string,
  projectId?: string,
): Skill[] {
  const results: Skill[] = []
  for (const entry of listDir(agentsDir)) {
    if (entry.endsWith('.md.disabled')) {
      const agentFile = path.join(agentsDir, entry)
      const name = path.basename(entry, '.md.disabled')
      const skill = buildSkill(agentFile, 'subagent', scope, account, name, projectId, true)
      if (skill) results.push(skill)
    } else if (entry.endsWith('.md')) {
      const agentFile = path.join(agentsDir, entry)
      const name = path.basename(entry, '.md')
      const skill = buildSkill(agentFile, 'subagent', scope, account, name, projectId)
      if (skill) results.push(skill)
    }
  }
  return results
}

// Read the cwd from the first parseable session file in a project dir.
// This is more reliable than decoding the hash (where / and spaces both become -).
function findProjectCwd(projectDir: string): string | null {
  for (const file of listDir(projectDir)) {
    if (!file.endsWith('.jsonl') || file === 'history.jsonl') continue
    try {
      const filePath = path.join(projectDir, file)
      const content = fs.readFileSync(filePath, 'utf-8')
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const obj = JSON.parse(trimmed) as Record<string, unknown>
        if (typeof obj['cwd'] === 'string' && obj['cwd']) return obj['cwd'] as string
      }
    } catch {
      continue
    }
  }
  return null
}

function discoverInAccount(accountDir: string, account: string): Skill[] {
  const skills: Skill[] = []

  skills.push(...discoverSkillsDir(path.join(accountDir, 'skills'), 'global', account))
  skills.push(...discoverCommandsDir(path.join(accountDir, 'commands'), 'global', account))
  skills.push(...discoverAgentsDir(path.join(accountDir, 'agents'), 'global', account))

  // Cursor ships a separate `skills-cursor/` tree alongside the user's
  // `skills/`. Same structure (one dir per skill, with SKILL.md), so we can
  // reuse discoverSkillsDir.
  if (account === 'cursor') {
    skills.push(...discoverSkillsDir(path.join(accountDir, 'skills-cursor'), 'global', account))
  }

  // Project-local discovery.
  // Claude Code stores project-local commands/skills in {cwd}/.claude/ — not in the
  // account's projects/ dir. We resolve the real path via the cwd field in session files.
  const projectsDir = path.join(accountDir, 'projects')
  for (const projectHash of listDir(projectsDir)) {
    const projectDir = path.join(projectsDir, projectHash)
    if (!isDir(projectDir)) continue

    const cwd = findProjectCwd(projectDir)
    // Use the real cwd as the projectId when available so the UI can show the actual name.
    const projectId = cwd ?? projectHash

    if (cwd) {
      const dotClaude = path.join(cwd, '.claude')
      skills.push(...discoverSkillsDir(path.join(dotClaude, 'skills'), 'project', account, projectId))
      skills.push(...discoverCommandsDir(path.join(dotClaude, 'commands'), 'project', account, projectId))
      skills.push(...discoverAgentsDir(path.join(dotClaude, 'agents'), 'project', account, projectId))
    }
  }

  return skills
}

export function discoverAllSkills(): Skill[] {
  const accounts = findAccounts()
  const raw: Skill[] = []

  for (const accountDir of accounts) {
    raw.push(...discoverInAccount(accountDir, accountLabel(accountDir)))
  }

  // Realpath dedup — defeat symlink shadows
  const seen = new Set<string>()
  const deduped: Skill[] = []
  for (const skill of raw) {
    if (seen.has(skill.realpath)) continue
    seen.add(skill.realpath)
    deduped.push(skill)
  }

  // Two-pass: build description counts, then recompute health with duplicate context.
  const descriptionCounts = new Map<string, number>()
  for (const skill of deduped) {
    if (!skill.description) continue
    const key = skill.description.toLowerCase().trim()
    descriptionCounts.set(key, (descriptionCounts.get(key) ?? 0) + 1)
  }

  const allNames = new Set(deduped.map(s => s.name))
  return deduped.map(skill => {
    // Strip 'health' out so we can rebuild the base object for computeHealth
    const { health: _health, ...base } = skill
    const health = computeHealth(base, { descriptionCounts })
    const references = extractReferences(skill, allNames)
    const suggestedType = inferType(skill)
    return { ...skill, health, references, suggestedType }
  })
}

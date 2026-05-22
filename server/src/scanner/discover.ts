import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseFrontmatter } from '../parser/frontmatter'
import { computeHealth } from './health'
import { extractReferences } from './references'
import { inferType } from './classification'
import { countTokens } from '../usage/tokenizer'
import { findCursorProjectCwds, defaultCursorUserDataDir } from './cursorProjects'
import { CURSOR_SEEN_LOG_PATH } from '../lib/paths'
import { discoverCodexSkills } from '../codex/discover'
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

  // Codex CLI: single ~/.codex/ tree, no settings.json. Sentinel against
  // either an AGENTS.md at the root OR a sessions/ dir — either is enough
  // proof that Codex is installed and worth scanning.
  const codexDir = path.join(home, '.codex')
  try {
    if (fs.statSync(codexDir).isDirectory()) {
      const hasLoadout = (
        fileExists(path.join(codexDir, 'AGENTS.md')) ||
        isDir(path.join(codexDir, 'sessions'))
      )
      if (hasLoadout) accounts.push(codexDir)
    }
  } catch {
    // .codex missing or unreadable — fine, just skip.
  }

  return accounts
}

export function accountLabel(accountDir: string): string {
  const base = path.basename(accountDir)
  if (base === '.cursor') return 'cursor'
  if (base === '.codex') return 'codex'
  return base === '.claude' ? 'default' : base.slice('.claude-'.length)
}

// Exported so per-ecosystem discovery modules (codex/, future others) can
// produce Skill rows that match the canonical shape — frontmatter parsing,
// health computation, ID encoding, token counting all live here in one place.
export function buildSkill(
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
    // Initial health pass here is throwaway — discoverAllSkills runs a
    // final two-pass recompute with descriptionCounts after dedup that
    // overwrites this. Skip the baseline write so we don't bake a
    // first-sighting baseline before dedup has had a chance to drop
    // symlink duplicates (LOC-50).
    const health: HealthResult = computeHealth(base, { skipBaselineWrite: true })
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

// Per-account discovery rules. Lifting these out of conditionals keeps the
// shared loop readable and makes it easy to add a third ecosystem later — a
// new entry here plus a `findAccounts` hook is the whole change.
interface AccountAdapter {
  /** Logical account label written into Skill.account. */
  account: string
  /** Root directory the adapter scans (e.g. ~/.claude, ~/.cursor). */
  accountDir: string
  /** Global-scope skill directories under `accountDir`. */
  globalSkillDirs: string[]
  /** Folder name to look for inside each project root for project-local
   *  skills/commands/agents (Claude uses `.claude`; Cursor uses `.cursor`). */
  projectArtifactDir: string
  /** Resolve every project root this account should scan. Each is a cwd
   *  expected to contain a `<projectArtifactDir>/` of artifacts. */
  resolveProjectCwds(): string[]
}

function adapterFor(accountDir: string, account: string): AccountAdapter {
  if (account === 'cursor') {
    return {
      account,
      accountDir,
      globalSkillDirs: ['skills', 'skills-cursor'],
      projectArtifactDir: '.cursor',
      resolveProjectCwds: () => findCursorProjectCwds({
        cursorDir: accountDir,
        userDataDir: defaultCursorUserDataDir(os.homedir()) ?? undefined,
        home: os.homedir(),
        seenLogPath: CURSOR_SEEN_LOG_PATH,
      }),
    }
  }
  return {
    account,
    accountDir,
    globalSkillDirs: ['skills'],
    projectArtifactDir: '.claude',
    resolveProjectCwds: () => resolveClaudeProjectCwds(accountDir),
  }
}

// Claude Code records every project it has been used in as a hash dir under
// `<accountDir>/projects/`, with session JSONLs whose `cwd` field is the
// real project path. We read the first parseable line per session file.
function resolveClaudeProjectCwds(accountDir: string): string[] {
  const out: string[] = []
  const projectsDir = path.join(accountDir, 'projects')
  for (const projectHash of listDir(projectsDir)) {
    const projectDir = path.join(projectsDir, projectHash)
    if (!isDir(projectDir)) continue
    const cwd = findProjectCwd(projectDir)
    if (cwd) out.push(cwd)
  }
  return out
}

function discoverInAccount(accountDir: string, account: string): Skill[] {
  // Codex's file model differs from Claude/Cursor — it uses a single
  // AGENTS.md per scope rather than skills/commands/agents directories.
  // Route it through a dedicated module instead of bending AccountAdapter
  // to fit both shapes.
  if (account === 'codex') return discoverCodexSkills(accountDir)

  const adapter = adapterFor(accountDir, account)
  const skills: Skill[] = []

  // Global-scope discovery.
  for (const dir of adapter.globalSkillDirs) {
    skills.push(...discoverSkillsDir(path.join(accountDir, dir), 'global', account))
  }
  skills.push(...discoverCommandsDir(path.join(accountDir, 'commands'), 'global', account))
  skills.push(...discoverAgentsDir(path.join(accountDir, 'agents'), 'global', account))

  // Project-scope discovery. The adapter knows where to look for project
  // roots and which child folder hosts the artifacts.
  for (const cwd of adapter.resolveProjectCwds()) {
    const artifactRoot = path.join(cwd, adapter.projectArtifactDir)
    skills.push(...discoverSkillsDir(path.join(artifactRoot, 'skills'), 'project', account, cwd))
    skills.push(...discoverCommandsDir(path.join(artifactRoot, 'commands'), 'project', account, cwd))
    skills.push(...discoverAgentsDir(path.join(artifactRoot, 'agents'), 'project', account, cwd))
  }

  return skills
}

export interface DiscoverOptions {
  /** Restrict discovery to the given account labels (e.g. ['cursor']). When
   *  omitted, every detected account is scanned — the original behavior. */
  accounts?: ReadonlyArray<string>
  /** Skip these accounts. Useful for "everything except Cursor" without
   *  needing to enumerate Claude's accounts ahead of time. */
  excludeAccounts?: ReadonlyArray<string>
}

export function discoverAllSkills(opts: DiscoverOptions = {}): Skill[] {
  const wanted = opts.accounts && opts.accounts.length > 0
    ? new Set(opts.accounts)
    : null
  const excluded = opts.excludeAccounts && opts.excludeAccounts.length > 0
    ? new Set(opts.excludeAccounts)
    : null
  const accounts = findAccounts().filter(dir => {
    const label = accountLabel(dir)
    if (wanted && !wanted.has(label)) return false
    if (excluded && excluded.has(label)) return false
    return true
  })
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

  // Reference resolution is scoped per-account so a Cursor skill cannot
  // reference a same-named Claude Code skill (and vice versa). The two
  // ecosystems are independent — a `morning-plan` in ~/.claude is a different
  // artifact than a `morning-plan` in ~/.cursor, even when the names collide.
  const namesByAccount = new Map<string, Set<string>>()
  for (const s of deduped) {
    let set = namesByAccount.get(s.account)
    if (!set) { set = new Set(); namesByAccount.set(s.account, set) }
    set.add(s.name)
  }
  return deduped.map(skill => {
    const { health: _health, ...base } = skill
    const health = computeHealth(base, { descriptionCounts })
    const references = extractReferences(skill, namesByAccount.get(skill.account) ?? new Set())
    const suggestedType = inferType(skill)
    return { ...skill, health, references, suggestedType }
  })
}

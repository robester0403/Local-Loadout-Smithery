import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseFrontmatter } from '../parser/frontmatter'
import { computeHealth } from './health'
import type { Skill, SkillType, SkillScope, HealthResult } from './types'

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
  return accounts
}

export function accountLabel(accountDir: string): string {
  const base = path.basename(accountDir)
  return base === '.claude' ? 'default' : base.slice('.claude-'.length)
}

function buildSkill(
  filePath: string,
  type: SkillType,
  scope: SkillScope,
  account: string,
  overrideName?: string,
  projectId?: string,
): Skill | null {
  try {
    const { meta, body } = parseFrontmatter(filePath)

    let realpath = filePath
    let isSymlink = false
    try {
      isSymlink = fs.lstatSync(filePath).isSymbolicLink()
      realpath = fs.realpathSync(filePath)
    } catch {
      // keep defaults
    }

    const stat = fs.statSync(filePath)

    const name =
      overrideName ||
      (meta['name'] as string | undefined) ||
      path.basename(path.dirname(filePath)) ||
      path.basename(filePath, '.md')

    const base: Omit<Skill, 'health'> = {
      id: Buffer.from(realpath).toString('base64'),
      name,
      description: (meta['description'] as string | undefined) || '',
      version: (meta['version'] as string | undefined) || '',
      type,
      scope,
      account,
      ...(projectId ? { projectId } : {}),
      path: filePath,
      realpath,
      isSymlink,
      body,
      frontmatter: meta,
      lastModified: stat.mtime.toISOString(),
    }
    const health: HealthResult = computeHealth(base)
    return { ...base, health }
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
    if (fileExists(skillFile)) {
      const skill = buildSkill(skillFile, 'skill', scope, account, undefined, projectId)
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
    if (entry.endsWith('.md')) {
      const name = path.basename(entry, '.md')
      const skill = buildSkill(full, 'command', scope, account, name, projectId)
      if (skill) results.push(skill)
    } else if (isDir(full)) {
      // Namespaced commands: commands/{namespace}/*.md → name = "namespace:command"
      for (const sub of listDir(full)) {
        if (!sub.endsWith('.md')) continue
        const subFile = path.join(full, sub)
        const name = `${entry}:${path.basename(sub, '.md')}`
        const skill = buildSkill(subFile, 'command', scope, account, name, projectId)
        if (skill) results.push(skill)
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
    if (!entry.endsWith('.md')) continue
    const agentFile = path.join(agentsDir, entry)
    const name = path.basename(entry, '.md')
    const skill = buildSkill(agentFile, 'agent', scope, account, name, projectId)
    if (skill) results.push(skill)
  }
  return results
}

function discoverInAccount(accountDir: string, account: string): Skill[] {
  const skills: Skill[] = []

  skills.push(...discoverSkillsDir(path.join(accountDir, 'skills'), 'global', account))
  skills.push(...discoverCommandsDir(path.join(accountDir, 'commands'), 'global', account))
  skills.push(...discoverAgentsDir(path.join(accountDir, 'agents'), 'global', account))

  // Project-local discovery: scan {account}/projects/*/
  const projectsDir = path.join(accountDir, 'projects')
  for (const projectHash of listDir(projectsDir)) {
    const projectDir = path.join(projectsDir, projectHash)
    if (!isDir(projectDir)) continue
    skills.push(...discoverSkillsDir(path.join(projectDir, 'skills'), 'project', account, projectHash))
    skills.push(...discoverCommandsDir(path.join(projectDir, 'commands'), 'project', account, projectHash))
    skills.push(...discoverAgentsDir(path.join(projectDir, 'agents'), 'project', account, projectHash))
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

  return deduped
}

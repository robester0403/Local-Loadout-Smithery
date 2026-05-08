import express, { type Request, type Response, type NextFunction } from 'express'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { exec, spawn } from 'child_process'
import { discoverAllSkills } from './scanner'
import { disableSkill, enableSkill } from './state'
import { loadUninstalled, uninstallSkill, restoreSkill, permanentDelete } from './state/uninstall'
import { listProfiles, createProfile, deleteProfile, activateProfile } from './state/profiles'
import { computeSkillAggregate } from './usage'
import { getSampleTurn } from './usage/sampleTurn'
import { breakdownForSkill } from './usage/breakdown'
import { parseTimeframe, sinceDate } from './usage/timeframe'
import {
  loadState, saveState, createGroup, updateGroup, deleteGroup,
  addMember, removeMember, setGlobalEnabled, setUseHook,
} from './superrouter/store'
import { writeGroupFile, deleteGroupFile } from './superrouter/routingFile'
import { updateGlobalClaude, updateProjectClaude } from './superrouter/claudeMdWriter'
import { installHook, uninstallHook, isHookInstalled } from './superrouter/hookGenerator'
import { computeDrift } from './superrouter/drift'
import { buildMCPInventory, refreshMCPInventory } from './mcp/inventory'
import { computeMCPUsage, computeMCPRelationships } from './mcp/usage'
import { countTokens } from './usage/tokenizer'

// Warm up the WASM tokenizer — first call is slow.
countTokens('')

const app = express()
const PORT = process.env.PORT || 3001

app.use(express.json())

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../../client/dist')))
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0' })
})

app.get('/api/inventory', (_req, res) => {
  try {
    const skills = discoverAllSkills()
    res.json({ skills })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.get('/api/usage/aggregate', (req, res) => {
  try {
    const tf = parseTimeframe(req.query['timeframe'])
    const since = sinceDate(tf) ?? undefined
    const summaries = computeSkillAggregate(undefined, since)
    res.json({ summaries })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/skills/:id/disable', (req, res) => {
  try {
    disableSkill(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/skills/:id/enable', (req, res) => {
  try {
    enableSkill(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.get('/api/profiles', (_req, res) => {
  try {
    res.json(listProfiles())
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/profiles', (req: Request, res: Response) => {
  const { name, skillIds } = req.body as { name?: string; skillIds?: string[] }
  if (!name || typeof name !== 'string' || !Array.isArray(skillIds)) {
    res.status(400).json({ error: 'name and skillIds are required' })
    return
  }
  try {
    createProfile(name.trim(), skillIds)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.delete('/api/profiles/:name', (req, res) => {
  try {
    deleteProfile(req.params.name)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/profiles/:name/activate', (req, res) => {
  const name = req.params.name === '__all__' ? null : req.params.name
  try {
    const skills = discoverAllSkills()
    activateProfile(name, skills.map(s => ({ id: s.id, disabled: s.disabled })))
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/launch-claude', (req: Request, res: Response) => {
  const { prompt } = req.body as { prompt?: string }
  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'prompt is required' })
    return
  }
  if (process.platform !== 'darwin') {
    res.json({ ok: true, platform: 'unsupported' })
    return
  }
  const pbcopy = spawn('pbcopy')
  pbcopy.stdin.write(prompt, 'utf-8')
  pbcopy.stdin.end()
  pbcopy.on('close', (copyCode) => {
    if (copyCode !== 0) {
      res.status(500).json({ error: 'Failed to copy to clipboard' })
      return
    }
    exec(`osascript -e 'tell application "Terminal" to do script "claude"'`, (launchErr) => {
      res.json({ ok: true, platform: 'darwin', launched: !launchErr })
    })
  })
})

app.get('/api/usage/sample-turn', (req, res) => {
  try {
    const tf = parseTimeframe(req.query['timeframe'])
    const since = sinceDate(tf) ?? undefined
    const sample = getSampleTurn(since)
    res.json({ sample })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.get('/api/usage/breakdown/:skillId', (req, res) => {
  let filePath: string
  try {
    filePath = Buffer.from(req.params.skillId, 'base64').toString('utf-8')
  } catch {
    res.status(400).json({ error: 'Invalid skillId' })
    return
  }

  const home = os.homedir()
  const normalized = path.resolve(filePath)
  if (normalized !== home && !normalized.startsWith(home + path.sep)) {
    res.status(403).json({ error: 'Path outside home directory' })
    return
  }

  const allSkills = discoverAllSkills()
  const skill =
    allSkills.find(s => s.path === filePath) ||
    allSkills.find(s => s.path === filePath + '.disabled') ||
    allSkills.find(s => s.path.replace(/\.disabled$/, '') === filePath) ||
    allSkills.find(s => s.realpath === normalized)

  if (!skill) {
    res.status(404).json({ error: 'Skill not found' })
    return
  }

  try {
    const tf = parseTimeframe(req.query['timeframe'])
    const since = sinceDate(tf) ?? undefined
    const breakdown = breakdownForSkill(skill.name, skill.description, skill.type, 100, since)
    res.json({ breakdown })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/skills/:id/reclassify', (req, res) => {
  const { newType } = req.body as { newType?: string }
  if (!newType || !['skill', 'command', 'subagent'].includes(newType)) {
    res.status(400).json({ error: 'newType must be skill, command, or subagent' })
    return
  }

  let logicalPath: string
  try {
    logicalPath = Buffer.from(req.params.id, 'base64').toString('utf-8')
  } catch {
    res.status(400).json({ error: 'Invalid id' })
    return
  }

  const home = os.homedir()
  if (!path.resolve(logicalPath).startsWith(home + path.sep)) {
    res.status(403).json({ error: 'Path outside home directory' })
    return
  }

  const isDisabled = !fs.existsSync(logicalPath) && fs.existsSync(logicalPath + '.disabled')
  const sourcePath = isDisabled ? logicalPath + '.disabled' : logicalPath
  if (!fs.existsSync(sourcePath)) {
    res.status(404).json({ error: 'Skill file not found' })
    return
  }

  // Derive type + name + accountDir from path structure
  const fileName = path.basename(logicalPath)
  let currentType: string
  let skillName: string
  let accountDir: string

  if (fileName === 'SKILL.md') {
    // skills/<name>/SKILL.md
    currentType = 'skill'
    skillName = path.basename(path.dirname(logicalPath))
    accountDir = path.dirname(path.dirname(path.dirname(logicalPath)))
  } else {
    const parentFolder = path.basename(path.dirname(logicalPath))
    if (parentFolder === 'commands') {
      currentType = 'command'
    } else if (parentFolder === 'agents') {
      currentType = 'subagent'
    } else {
      res.status(400).json({ error: 'Namespaced commands are not supported for reclassify' })
      return
    }
    skillName = path.basename(logicalPath, '.md')
    accountDir = path.dirname(path.dirname(logicalPath))
  }

  if (currentType === newType) {
    res.status(400).json({ error: 'Skill is already this type' })
    return
  }

  let destLogical: string
  if (newType === 'skill') {
    destLogical = path.join(accountDir, 'skills', skillName, 'SKILL.md')
  } else if (newType === 'command') {
    destLogical = path.join(accountDir, 'commands', skillName + '.md')
  } else {
    destLogical = path.join(accountDir, 'agents', skillName + '.md')
  }

  if (!path.resolve(destLogical).startsWith(home + path.sep)) {
    res.status(403).json({ error: 'Destination outside home directory' })
    return
  }

  const destPath = isDisabled ? destLogical + '.disabled' : destLogical
  if (fs.existsSync(destPath)) {
    res.status(409).json({ error: `Destination already exists: ${destPath}` })
    return
  }

  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    fs.renameSync(sourcePath, destPath)

    const logDir = path.join(home, '.local-skill-manager')
    fs.mkdirSync(logDir, { recursive: true })
    fs.appendFileSync(
      path.join(logDir, 'move-log.jsonl'),
      JSON.stringify({ from: sourcePath, to: destPath, timestamp: new Date().toISOString(), id: req.params.id }) + '\n',
    )

    const newId = Buffer.from(destLogical).toString('base64')
    res.json({ ok: true, from: sourcePath, to: destPath, newId })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/skills/:id/open', (req, res) => {
  let filePath: string
  try {
    filePath = Buffer.from(req.params.id, 'base64').toString('utf-8')
  } catch {
    res.status(400).json({ error: 'Invalid id' })
    return
  }

  const home = os.homedir()
  const normalized = path.resolve(filePath)
  if (normalized !== home && !normalized.startsWith(home + path.sep)) {
    res.status(403).json({ error: 'Path outside home directory' })
    return
  }

  let cmd: string
  if (process.platform === 'darwin') cmd = 'open'
  else if (process.platform === 'win32') cmd = 'start ""'
  else cmd = 'xdg-open'

  exec(`${cmd} ${JSON.stringify(filePath)}`, (err) => {
    if (err) { res.status(500).json({ error: err.message }); return }
    res.json({ ok: true })
  })
})

// ── Uninstall / Trash ────────────────────────────────────────────────────────

app.get('/api/uninstalled', (_req, res) => {
  res.json({ entries: loadUninstalled() })
})

app.post('/api/skills/:id/uninstall', (req, res) => {
  let logicalPath: string
  try {
    logicalPath = Buffer.from(req.params.id, 'base64').toString('utf-8')
  } catch {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  const home = os.homedir()
  if (!path.resolve(logicalPath).startsWith(home + path.sep)) {
    res.status(403).json({ error: 'Path outside home directory' })
    return
  }

  const actualPath = fs.existsSync(logicalPath) ? logicalPath
    : fs.existsSync(logicalPath + '.disabled') ? logicalPath + '.disabled'
    : null
  if (!actualPath) {
    res.status(404).json({ error: 'Skill file not found' })
    return
  }

  const inventory = discoverAllSkills()
  const skill = inventory.find(s => s.realpath === logicalPath || s.path === actualPath)
  if (!skill) {
    res.status(404).json({ error: 'Skill not found in inventory' })
    return
  }

  // Move the physical file (realpath); storing it so restore puts it back in the right place
  const physicalPath = skill.realpath || actualPath

  try {
    uninstallSkill(req.params.id, physicalPath, {
      name: skill.name,
      description: skill.description,
      type: skill.type,
      scope: skill.scope,
      account: skill.account,
    })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/uninstalled/:id/restore', (req, res) => {
  try {
    const restoredPath = restoreSkill(req.params.id)
    res.json({ ok: true, restoredPath })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.delete('/api/uninstalled/:id', (req, res) => {
  try {
    permanentDelete(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// ── SuperRouter ──────────────────────────────────────────────────────────────

function syncClaudeMd(allGroups: ReturnType<typeof loadState>['groups']) {
  // Global CLAUDE.md: include all enabled global groups
  const enabledGlobal = allGroups.filter(g => g.enabled && g.scope === 'global')
  updateGlobalClaude(enabledGlobal)
  // Project CLAUDE.md: group by projectPath, update each
  const projectPaths = new Set(
    allGroups.filter(g => g.enabled && g.scope === 'project' && g.projectPath).map(g => g.projectPath!)
  )
  for (const projectPath of projectPaths) {
    const groups = allGroups.filter(g => g.enabled && g.scope === 'project' && g.projectPath === projectPath)
    updateProjectClaude(projectPath, groups)
  }
}

app.get('/api/superrouter/state', (_req, res) => {
  try {
    const state = loadState()
    const inventory = discoverAllSkills()
    const enriched = computeDrift(
      state.groups,
      inventory.map(s => ({ id: s.id, name: s.name, description: s.description })),
    )
    res.json({ ...state, groups: enriched, hookInstalled: isHookInstalled() })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/superrouter/groups', (req, res) => {
  const { name, description, keywords, scope, projectPath } = req.body as {
    name?: string; description?: string; keywords?: string[]
    scope?: string; projectPath?: string
  }
  if (!name || !description || !Array.isArray(keywords) || !scope) {
    res.status(400).json({ error: 'name, description, keywords, scope are required' })
    return
  }
  if (scope !== 'global' && scope !== 'project') {
    res.status(400).json({ error: 'scope must be global or project' })
    return
  }
  try {
    const group = createGroup({ name, description, keywords, scope, projectPath })
    res.json({ group })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.put('/api/superrouter/groups/:id', (req, res) => {
  const { name, description, keywords, scope, projectPath, enabled } = req.body as Partial<{
    name: string; description: string; keywords: string[]
    scope: 'global' | 'project'; projectPath: string; enabled: boolean
  }>
  try {
    const group = updateGroup(req.params.id, { name, description, keywords, scope, projectPath, enabled })
    const state = loadState()
    // Regenerate routing file if group has members
    if (group.members.length > 0) {
      const inventory = discoverAllSkills()
      const skillMap = new Map(inventory.map(s => [s.id, { name: s.name, description: s.description }]))
      writeGroupFile(group, skillMap)
    }
    syncClaudeMd(state.groups)
    res.json({ group })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.delete('/api/superrouter/groups/:id', (req, res) => {
  try {
    const state = loadState()
    const group = state.groups.find(g => g.id === req.params.id)
    if (!group) { res.status(404).json({ error: 'Group not found' }); return }
    deleteGroup(req.params.id)
    deleteGroupFile(req.params.id)
    const updated = loadState()
    syncClaudeMd(updated.groups)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/superrouter/groups/:id/members/:skillId', (req, res) => {
  const { name, description } = req.body as { name?: string; description?: string }
  if (!name || description === undefined) {
    res.status(400).json({ error: 'name and description are required' })
    return
  }
  try {
    const member = addMember(req.params.id, req.params.skillId, name, description)
    const state = loadState()
    const group = state.groups.find(g => g.id === req.params.id)!
    const inventory = discoverAllSkills()
    const skillMap = new Map(inventory.map(s => [s.id, { name: s.name, description: s.description }]))
    writeGroupFile(group, skillMap)
    syncClaudeMd(state.groups)
    res.json({ member })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.delete('/api/superrouter/groups/:id/members/:skillId', (req, res) => {
  try {
    removeMember(req.params.id, req.params.skillId)
    const state = loadState()
    const group = state.groups.find(g => g.id === req.params.id)!
    const inventory = discoverAllSkills()
    const skillMap = new Map(inventory.map(s => [s.id, { name: s.name, description: s.description }]))
    writeGroupFile(group, skillMap)
    syncClaudeMd(state.groups)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/superrouter/global-toggle', (req, res) => {
  const { enabled, useHook } = req.body as { enabled?: boolean; useHook?: boolean }
  try {
    if (typeof enabled === 'boolean') setGlobalEnabled(enabled)
    if (typeof useHook === 'boolean') {
      setUseHook(useHook)
      if (useHook) {
        installHook()
      } else {
        uninstallHook()
      }
    }
    const state = loadState()
    syncClaudeMd(state.groups)
    res.json({ ok: true, hookInstalled: isHookInstalled() })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// ── MCP inventory ────────────────────────────────────────────────────────────

app.get('/api/mcp/inventory', async (_req, res) => {
  try {
    const servers = await buildMCPInventory()
    res.json({ servers })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/mcp/refresh', async (_req, res) => {
  try {
    const servers = await refreshMCPInventory()
    res.json({ servers })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.get('/api/mcp/usage', (req, res) => {
  try {
    const tf = parseTimeframe(req.query.timeframe)
    const since = sinceDate(tf) ?? undefined
    const summaries = computeMCPUsage(since)
    res.json({ summaries })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.get('/api/mcp/relationships', (_req, res) => {
  try {
    const relationships = computeMCPRelationships()
    res.json({ relationships })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────

// 404 for unknown API routes (must be before static fallback)
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// In production, serve the SPA for any non-API route
if (process.env.NODE_ENV === 'production') {
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '../../client/dist/index.html'))
  })
}

// Global error handler — catches anything thrown by middleware/routes
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[LSM]', err.message)
  res.status(500).json({ error: err.message })
})

app.listen(PORT, () => {
  const line = '─'.repeat(44)
  console.log(`\n\x1b[36m┌${line}┐\x1b[0m`)
  console.log(`\x1b[36m│\x1b[0m  \x1b[1mLocal Skill Manager\x1b[0m                        \x1b[36m│\x1b[0m`)
  console.log(`\x1b[36m│\x1b[0m  API server  →  http://localhost:${PORT}           \x1b[36m│\x1b[0m`)
  if (process.env.NODE_ENV !== 'production') {
    console.log(`\x1b[36m│\x1b[0m  \x1b[1m\x1b[32mOpen in browser → http://localhost:5173\x1b[0m     \x1b[36m│\x1b[0m`)
  }
  console.log(`\x1b[36m└${line}┘\x1b[0m\n`)
})

export default app

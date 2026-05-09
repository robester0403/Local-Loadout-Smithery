import { Router } from 'express'
import { discoverAllSkills } from '../scanner'
import {
  addMember,
  createGroup,
  deleteGroup,
  loadState,
  removeMember,
  setGlobalEnabled,
  setUseHook,
  updateGroup,
} from '../superrouter/store'
import { deleteGroupFile, writeGroupFile } from '../superrouter/routingFile'
import { updateGlobalClaude, updateProjectClaude } from '../superrouter/claudeMdWriter'
import { installHook, isHookInstalled, uninstallHook } from '../superrouter/hookGenerator'
import { computeDrift } from '../superrouter/drift'
import { asyncHandler } from '../lib/asyncHandler'
import { pathParam } from '../lib/params'
import { HttpError } from '../lib/paths'
import type { RoutingGroup } from '../superrouter/types'

const router = Router()

// Push group state out to the user's CLAUDE.md files. Called after any
// state mutation so the on-disk routing config stays in sync.
function syncClaudeMd(allGroups: RoutingGroup[]): void {
  const enabledGlobal = allGroups.filter(g => g.enabled && g.scope === 'global')
  updateGlobalClaude(enabledGlobal)

  const projectPaths = new Set(
    allGroups
      .filter(g => g.enabled && g.scope === 'project' && g.projectPath)
      .map(g => g.projectPath!),
  )
  for (const projectPath of projectPaths) {
    const groups = allGroups.filter(
      g => g.enabled && g.scope === 'project' && g.projectPath === projectPath,
    )
    updateProjectClaude(projectPath, groups)
  }
}

// Build a lookup map for skill metadata, used when generating routing files.
function skillLookup(): Map<string, { name: string; description: string }> {
  const inventory = discoverAllSkills()
  return new Map(inventory.map(s => [s.id, { name: s.name, description: s.description }]))
}

router.get('/superrouter/state', asyncHandler((_req, res) => {
  const state = loadState()
  const inventory = discoverAllSkills()
  const enriched = computeDrift(
    state.groups,
    inventory.map(s => ({ id: s.id, name: s.name, description: s.description })),
  )
  res.json({ ...state, groups: enriched, hookInstalled: isHookInstalled() })
}))

router.post('/superrouter/groups', asyncHandler((req, res) => {
  const { name, description, keywords, scope, projectPath } = req.body as {
    name?: string
    description?: string
    keywords?: string[]
    scope?: string
    projectPath?: string
  }
  if (!name || !description || !Array.isArray(keywords) || !scope) {
    throw new HttpError(400, 'name, description, keywords, scope are required')
  }
  if (scope !== 'global' && scope !== 'project') {
    throw new HttpError(400, 'scope must be global or project')
  }
  const group = createGroup({ name, description, keywords, scope, projectPath })
  res.json({ group })
}))

router.put('/superrouter/groups/:id', asyncHandler((req, res) => {
  const { name, description, keywords, scope, projectPath, enabled } = req.body as Partial<{
    name: string
    description: string
    keywords: string[]
    scope: 'global' | 'project'
    projectPath: string
    enabled: boolean
  }>
  const group = updateGroup(pathParam(req, 'id'), { name, description, keywords, scope, projectPath, enabled })
  if (group.members.length > 0) {
    writeGroupFile(group, skillLookup())
  }
  syncClaudeMd(loadState().groups)
  res.json({ group })
}))

router.delete('/superrouter/groups/:id', asyncHandler((req, res) => {
  const state = loadState()
  const group = state.groups.find(g => g.id === pathParam(req, 'id'))
  if (!group) throw new HttpError(404, 'Group not found')
  deleteGroup(pathParam(req, 'id'))
  deleteGroupFile(pathParam(req, 'id'))
  syncClaudeMd(loadState().groups)
  res.json({ ok: true })
}))

router.post('/superrouter/groups/:id/members/:skillId', asyncHandler((req, res) => {
  const { name, description } = req.body as { name?: string; description?: string }
  if (!name || description === undefined) {
    throw new HttpError(400, 'name and description are required')
  }
  const member = addMember(pathParam(req, 'id'), pathParam(req, 'skillId'), name, description)
  const state = loadState()
  const group = state.groups.find(g => g.id === pathParam(req, 'id'))
  if (group) writeGroupFile(group, skillLookup())
  syncClaudeMd(state.groups)
  res.json({ member })
}))

router.delete('/superrouter/groups/:id/members/:skillId', asyncHandler((req, res) => {
  removeMember(pathParam(req, 'id'), pathParam(req, 'skillId'))
  const state = loadState()
  const group = state.groups.find(g => g.id === pathParam(req, 'id'))
  if (group) writeGroupFile(group, skillLookup())
  syncClaudeMd(state.groups)
  res.json({ ok: true })
}))

router.post('/superrouter/global-toggle', asyncHandler((req, res) => {
  const { enabled, useHook } = req.body as { enabled?: boolean; useHook?: boolean }
  if (typeof enabled === 'boolean') setGlobalEnabled(enabled)
  if (typeof useHook === 'boolean') {
    setUseHook(useHook)
    if (useHook) installHook()
    else uninstallHook()
  }
  syncClaudeMd(loadState().groups)
  res.json({ ok: true, hookInstalled: isHookInstalled() })
}))

export default router

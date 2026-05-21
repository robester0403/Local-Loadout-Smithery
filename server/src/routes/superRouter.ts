import { Router } from 'express'
import fs from 'fs'
import { asyncHandler } from '../lib/asyncHandler'
import { openInSystem } from '../lib/openInSystem'
import { assertWithinHome, HttpError } from '../lib/paths'
import { pathParam } from '../lib/params'
import { discoverAllSkills } from '../scanner/discover'
import {
  createBundle,
  deleteBundle,
  getBundle,
  listBundles,
  setEnabled,
  updateBundle,
} from '../superRouter/store'
import { validateBundleInput } from '../superRouter/validate'
import { applyBundle, removeBundle, type ResolvedSkillRow } from '../superRouter/writer'
import { detectDrift } from '../superRouter/drift'
import { resolveBundlePaths } from '../superRouter/paths'
import type { Bundle, BundleInput, BundleSkillEntry } from '../superRouter/types'
import type { Skill } from '../scanner/types'

const router = Router()

function parseInput(body: unknown): BundleInput {
  const b = body as Partial<BundleInput> | null
  if (!b || typeof b !== 'object') {
    throw new HttpError(400, 'Request body required')
  }
  const target = b.target
  if (target !== 'claude' && target !== 'cursor' && target !== 'codex') {
    throw new HttpError(400, 'target must be "claude", "cursor", or "codex"')
  }
  const scope = b.scope
  if (!scope || (scope.kind !== 'global' && scope.kind !== 'project')) {
    throw new HttpError(400, 'scope must be global or project')
  }
  // Accept either the new `skills: [{id, description?}]` shape or — for
  // forward-compat with the simpler form — a bare `skillIds: string[]`.
  let skills: BundleSkillEntry[] = []
  const bag = b as { skills?: unknown; skillIds?: unknown }
  if (Array.isArray(bag.skills)) {
    skills = bag.skills
      .filter((e): e is BundleSkillEntry => !!e && typeof (e as BundleSkillEntry).id === 'string')
      .map(e => {
        const desc = typeof e.description === 'string' ? e.description.trim() : ''
        return desc ? { id: e.id, description: desc } : { id: e.id }
      })
  } else if (Array.isArray(bag.skillIds)) {
    skills = bag.skillIds
      .filter((id): id is string => typeof id === 'string')
      .map(id => ({ id }))
  }
  return {
    name: typeof b.name === 'string' ? b.name.trim() : '',
    target,
    scope: scope.kind === 'project'
      ? { kind: 'project', path: typeof scope.path === 'string' ? scope.path : '' }
      : { kind: 'global' },
    trigger: typeof b.trigger === 'string' ? b.trigger : '',
    skills,
  }
}

function resolveRows(skills: Skill[], entries: BundleSkillEntry[]): ResolvedSkillRow[] {
  const byId = new Map(skills.map(s => [s.id, s]))
  const rows: ResolvedSkillRow[] = []
  for (const entry of entries) {
    const skill = byId.get(entry.id)
    if (skill) rows.push({ entry, skill })
  }
  return rows
}

function bundleWithPaths(b: Bundle) {
  const p = resolveBundlePaths(b)
  return { ...b, paths: p }
}

function throwValidation(errs: ReturnType<typeof validateBundleInput>): never {
  // 422 — semantically distinct from 400 (malformed) and lets the client
  // surface field-level errors.
  const err = new HttpError(422, 'Validation failed')
  ;(err as HttpError & { details?: unknown }).details = errs
  throw err
}

router.get('/super-router/bundles', asyncHandler((_req, res) => {
  res.json({ bundles: listBundles().map(bundleWithPaths) })
}))

router.get('/super-router/drift', asyncHandler((_req, res) => {
  const bundles = listBundles().filter(b => b.enabled)
  if (bundles.length === 0) {
    res.json({ results: [] })
    return
  }
  const skills = discoverAllSkills()
  const results = bundles.map(b => detectDrift(b, resolveRows(skills, b.skills)))
  res.json({ results })
}))

router.post('/super-router/bundles', asyncHandler((req, res) => {
  const input = parseInput(req.body)
  const skills = discoverAllSkills()
  const errs = validateBundleInput(input, skills)
  if (errs.length > 0) throwValidation(errs)
  const created = createBundle(input)
  res.status(201).json({ bundle: bundleWithPaths(created) })
}))

router.put('/super-router/bundles/:id', asyncHandler((req, res) => {
  const id = pathParam(req, 'id')
  const existing = getBundle(id)
  if (!existing) throw new HttpError(404, 'Bundle not found')
  const input = parseInput(req.body)
  const skills = discoverAllSkills()
  const errs = validateBundleInput(input, skills)
  if (errs.length > 0) throwValidation(errs)
  const updated = updateBundle(id, input)
  // If currently enabled, rewrite files to match the new content. The old
  // marker block is keyed by id (unchanged) so it strips cleanly during apply.
  if (updated.enabled) {
    applyBundle(updated, resolveRows(skills, updated.skills))
  }
  res.json({ bundle: bundleWithPaths(updated) })
}))

router.post('/super-router/bundles/:id/toggle', asyncHandler((req, res) => {
  const id = pathParam(req, 'id')
  const existing = getBundle(id)
  if (!existing) throw new HttpError(404, 'Bundle not found')
  const enabled = (req.body as { enabled?: boolean })?.enabled
  if (typeof enabled !== 'boolean') {
    throw new HttpError(400, 'enabled (boolean) is required')
  }

  if (enabled) {
    const skills = discoverAllSkills()
    const errs = validateBundleInput(
      {
        name: existing.name,
        target: existing.target,
        scope: existing.scope,
        trigger: existing.trigger,
        skills: existing.skills,
      },
      skills,
    )
    if (errs.length > 0) throwValidation(errs)
    const next = setEnabled(id, true)
    applyBundle(next, resolveRows(skills, next.skills))
    res.json({ bundle: bundleWithPaths(next) })
    return
  }

  removeBundle(existing)
  const next = setEnabled(id, false)
  res.json({ bundle: bundleWithPaths(next) })
}))

router.post('/super-router/bundles/:id/open', asyncHandler(async (req, res) => {
  const id = pathParam(req, 'id')
  const existing = getBundle(id)
  if (!existing) throw new HttpError(404, 'Bundle not found')
  const which = (req.body as { which?: 'top' | 'map' })?.which ?? 'top'
  if (which !== 'top' && which !== 'map') {
    throw new HttpError(400, 'which must be "top" or "map"')
  }
  const paths = resolveBundlePaths(existing)
  const target = which === 'top' ? paths.topFile : paths.mapFile
  assertWithinHome(target)
  if (!fs.existsSync(target)) {
    throw new HttpError(404, `${which === 'top' ? 'Top MD' : 'Map'} file does not exist yet: ${target}`)
  }
  await openInSystem(target)
  res.json({ ok: true, opened: target })
}))

router.delete('/super-router/bundles/:id', asyncHandler((req, res) => {
  const id = pathParam(req, 'id')
  const existing = getBundle(id)
  if (!existing) {
    res.json({ ok: true })
    return
  }
  if (existing.enabled) removeBundle(existing)
  deleteBundle(id)
  res.json({ ok: true })
}))

export default router

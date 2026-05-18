import { Router } from 'express'
import { asyncHandler } from '../lib/asyncHandler'
import { HttpError } from '../lib/paths'
import { pathParam } from '../lib/params'
import { readSentinel, runExtraction } from '../extractors'
import { runDigest } from '../harvester/digest'
import { deleteById, getById, readAll, setImprovementNotes, setStatus, updateFields } from '../harvester/store'
import { emitFromCandidate } from '../harvester/emit'
import { findExistingMatch } from '../harvester/matcher'
import { compareCandidate } from '../harvester/compare'
import { findAccounts, accountLabel, discoverAllSkills } from '../scanner/discover'
import { read as readSettings } from '../state/settings'
import type { ConversationSource } from '../extractors/types'
import type { CandidateType } from '../harvester/types'

const router = Router()

router.get('/harvester/status', asyncHandler((_req, res) => {
  const s = readSentinel()
  res.json({ lastRunAt: s.lastRunAt, highWaterMark: s.highWaterMark })
}))

router.post('/harvester/extract', asyncHandler((req, res) => {
  const body = (req.body ?? {}) as { lookbackDays?: number; sources?: string[] }
  let lookbackDays: number | undefined
  if (body.lookbackDays !== undefined) {
    if (typeof body.lookbackDays !== 'number' || body.lookbackDays <= 0 || body.lookbackDays > 365) {
      throw new HttpError(400, 'lookbackDays must be a positive number ≤ 365')
    }
    lookbackDays = body.lookbackDays
  }
  let sources: ConversationSource[] | undefined
  if (body.sources !== undefined) {
    if (!Array.isArray(body.sources)) {
      throw new HttpError(400, 'sources must be an array')
    }
    const valid: ConversationSource[] = ['claude', 'cursor', 'codex']
    sources = body.sources.filter((s): s is ConversationSource => valid.includes(s as ConversationSource))
    if (sources.length === 0) {
      throw new HttpError(400, 'sources must contain at least one of: claude, cursor, codex')
    }
  }
  const result = runExtraction({ lookbackDays, sources })
  res.json(result)
}))

// ─── Digest ──────────────────────────────────────────────────────────────────

router.post('/harvester/digest', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as { lookbackDays?: number; model?: string; purgeRawOnSuccess?: boolean }
  const settings = readSettings()
  const model = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : settings.harvester.model
  if (!model) throw new HttpError(400, 'No model selected. Pick one in Settings or pass `model` in the body.')

  const lookbackDays = typeof body.lookbackDays === 'number' && body.lookbackDays > 0
    ? body.lookbackDays
    : 14
  const sinceIso = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString()
  const purge = body.purgeRawOnSuccess !== false // default true

  const result = await runDigest({ model, sinceIso, purgeRawOnSuccess: purge })
  res.json(result)
}))

// ─── Candidates CRUD ─────────────────────────────────────────────────────────

router.get('/harvester/candidates', asyncHandler((_req, res) => {
  // Tag each candidate with the closest existing inventory match (if any).
  // Recomputed on every request so newly-installed skills automatically
  // flag previously-stored candidates as duplicates.
  const inventory = discoverAllSkills()
  const candidates = readAll().map(c => ({
    ...c,
    existingMatch: findExistingMatch(c, inventory),
  }))
  res.json({ candidates })
}))

router.patch('/harvester/candidates/:id', asyncHandler((req, res) => {
  const id = pathParam(req, 'id')
  if (!getById(id)) throw new HttpError(404, 'Candidate not found')
  const body = (req.body ?? {}) as Partial<{ name: string; description: string; bodyDraft: string; suggestedType: CandidateType }>
  const patch: Partial<{ name: string; description: string; bodyDraft: string; suggestedType: CandidateType }> = {}
  if (typeof body.name === 'string') patch.name = body.name
  if (typeof body.description === 'string') patch.description = body.description
  if (typeof body.bodyDraft === 'string') patch.bodyDraft = body.bodyDraft
  if (body.suggestedType === 'skill' || body.suggestedType === 'command' || body.suggestedType === 'subagent') {
    patch.suggestedType = body.suggestedType
  }
  res.json({ candidate: updateFields(id, patch) })
}))

router.post('/harvester/candidates/:id/reject', asyncHandler((req, res) => {
  const id = pathParam(req, 'id')
  if (!getById(id)) throw new HttpError(404, 'Candidate not found')
  res.json({ candidate: setStatus(id, 'rejected') })
}))

router.delete('/harvester/candidates/:id', asyncHandler((req, res) => {
  const id = pathParam(req, 'id')
  deleteById(id)
  res.json({ ok: true })
}))

// Accept = write a real SKILL.md (or .md) to a loadout dir. The candidate
// becomes status=accepted with a back-pointer to the file we wrote.
router.post('/harvester/candidates/:id/accept', asyncHandler((req, res) => {
  const id = pathParam(req, 'id')
  const cand = getById(id)
  if (!cand) throw new HttpError(404, 'Candidate not found')
  const body = (req.body ?? {}) as {
    accountDir?: string
    scope?: 'global' | 'project'
    projectPath?: string
    name?: string
    description?: string
    body?: string
    type?: CandidateType
  }
  if (typeof body.accountDir !== 'string') throw new HttpError(400, 'accountDir is required')
  if (body.scope !== 'global' && body.scope !== 'project') throw new HttpError(400, 'scope must be "global" or "project"')
  if (body.type !== 'skill' && body.type !== 'command' && body.type !== 'subagent') {
    throw new HttpError(400, 'type must be skill / command / subagent')
  }
  const result = emitFromCandidate(cand, {
    accountDir: body.accountDir,
    scope: body.scope,
    projectPath: body.projectPath,
    name: typeof body.name === 'string' && body.name.trim() ? body.name : cand.name,
    description: typeof body.description === 'string' && body.description.trim() ? body.description : cand.description,
    body: typeof body.body === 'string' ? body.body : cand.bodyDraft,
    type: body.type,
  })
  res.json(result)
}))

// Compare a candidate against its existing-match skill, asking the model
// what concrete additions the candidate offers over the existing file. Result
// is cached on the candidate so re-clicks are free.
router.post('/harvester/candidates/:id/compare', asyncHandler(async (req, res) => {
  const id = pathParam(req, 'id')
  const cand = getById(id)
  if (!cand) throw new HttpError(404, 'Candidate not found')
  const settings = readSettings()
  const body = (req.body ?? {}) as { model?: string; force?: boolean }
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : settings.harvester.model
  if (!model) throw new HttpError(400, 'No model selected. Pick one in Settings or pass `model`.')

  const inventory = discoverAllSkills()
  const match = findExistingMatch(cand, inventory)
  if (!match) throw new HttpError(400, 'Candidate has no existing-match skill to compare against.')

  // Cached result short-circuit (unless caller forces a recompute).
  if (!body.force && cand.improvementNotes && cand.improvementNotes.comparedSkillId === match.skillId) {
    res.json({ candidate: cand, cached: true })
    return
  }

  const existing = inventory.find(s => s.id === match.skillId)
  if (!existing) throw new HttpError(404, 'Matched skill no longer exists in inventory.')

  const notes = await compareCandidate({ candidate: cand, existing, model })
  const updated = setImprovementNotes(id, notes)
  res.json({ candidate: { ...updated, existingMatch: match }, cached: false })
}))

// Accounts list, used by the accept-modal to populate the dropdown.
router.get('/harvester/accounts', asyncHandler((_req, res) => {
  const accounts = findAccounts().map(dir => ({ dir, label: accountLabel(dir) }))
  res.json({ accounts })
}))

export default router

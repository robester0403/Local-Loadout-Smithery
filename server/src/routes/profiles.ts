import { Router } from 'express'
import { discoverAllSkills } from '../scanner'
import {
  activateProfile,
  createProfile,
  deleteProfile,
  listProfiles,
} from '../state/profiles'
import { asyncHandler } from '../lib/asyncHandler'
import { pathParam } from '../lib/params'
import { HttpError } from '../lib/paths'

const router = Router()

router.get('/profiles', asyncHandler((_req, res) => {
  res.json(listProfiles())
}))

router.post('/profiles', asyncHandler((req, res) => {
  const { name, skillIds } = req.body as { name?: string; skillIds?: string[] }
  if (!name || typeof name !== 'string' || !Array.isArray(skillIds)) {
    throw new HttpError(400, 'name and skillIds are required')
  }
  createProfile(name.trim(), skillIds)
  res.json({ ok: true })
}))

router.delete('/profiles/:name', asyncHandler((req, res) => {
  deleteProfile(pathParam(req, 'name'))
  res.json({ ok: true })
}))

router.post('/profiles/:name/activate', asyncHandler((req, res) => {
  // The synthetic name '__all__' represents "no profile, restore everything".
  const raw = pathParam(req, 'name')
  const name = raw === '__all__' ? null : raw
  const skills = discoverAllSkills()
  activateProfile(name, skills.map(s => ({ id: s.id, disabled: s.disabled })))
  res.json({ ok: true })
}))

export default router

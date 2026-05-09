import { Router } from 'express'
import { discoverAllSkills } from '../scanner'
import { computeSkillAggregate } from '../usage'
import { breakdownForSkill } from '../usage/breakdown'
import { getSampleTurn } from '../usage/sampleTurn'
import { parseTimeframe, sinceDate } from '../usage/timeframe'
import { asyncHandler } from '../lib/asyncHandler'
import { decodeSkillId } from '../lib/ids'
import { assertWithinHome, HttpError } from '../lib/paths'
import path from 'path'
import type { Request } from 'express'

const router = Router()

// Resolves a `since` Date from the optional ?timeframe query param.
function sinceFromQuery(req: Request): Date | undefined {
  const tf = parseTimeframe(req.query['timeframe'])
  return sinceDate(tf) ?? undefined
}

router.get('/usage/aggregate', asyncHandler((req, res) => {
  const summaries = computeSkillAggregate(undefined, sinceFromQuery(req))
  res.json({ summaries })
}))

router.get('/usage/sample-turn', asyncHandler((req, res) => {
  const sample = getSampleTurn(sinceFromQuery(req))
  res.json({ sample })
}))

router.get('/usage/breakdown/:skillId', asyncHandler((req, res) => {
  const filePath = decodeSkillId(req.params.skillId)
  assertWithinHome(filePath)

  const allSkills = discoverAllSkills()
  // Try a few path variants — the encoded path may be the logical (.disabled-stripped)
  // form, the actual on-disk path, or a realpath if symlinked.
  const normalized = path.resolve(filePath)
  const skill =
    allSkills.find(s => s.path === filePath) ||
    allSkills.find(s => s.path === filePath + '.disabled') ||
    allSkills.find(s => s.path.replace(/\.disabled$/, '') === filePath) ||
    allSkills.find(s => s.realpath === normalized)

  if (!skill) throw new HttpError(404, 'Skill not found')

  // High cap — with the per-session loaded summary, total rows are bounded by
  // (active activations + 1 per session), well under any reasonable cap.
  const breakdown = breakdownForSkill(
    skill.name,
    skill.description,
    skill.type,
    10_000,
    sinceFromQuery(req),
  )
  res.json({ breakdown })
}))

export default router

import { Router } from 'express'
import { asyncHandler } from '../lib/asyncHandler'
import { HttpError } from '../lib/paths'
import { pathParam } from '../lib/params'
import { discoverAllSkills } from '../scanner/discover'
import { scanContent, summarize } from '../security'

const router = Router()

// Scan a single skill (by encoded path id) for known harmful content patterns.
// Body and description are scanned together so a description with a hidden
// "ignore previous instructions" string trips the same alarm as the body.
// Account-agnostic — same code path serves Claude and Cursor inventory rows.
router.get('/security/scan/:id', asyncHandler((req, res) => {
  const encoded = pathParam(req, 'id')
  const inventory = discoverAllSkills()
  const skill = inventory.find(s => s.id === encoded)
  if (!skill) throw new HttpError(404, 'Skill not found')
  const text = [skill.description ?? '', skill.body ?? ''].join('\n\n')
  const findings = scanContent(text)
  res.json({
    skillId: skill.id,
    summary: summarize(findings),
    findings,
  })
}))

// Scan arbitrary text — used by the Auto Skill review surface to check a
// candidate's proposed body before the user accepts it (and before the file
// is written to disk).
router.post('/security/scan', asyncHandler((req, res) => {
  const body = req.body as { text?: unknown } | null
  if (!body || typeof body.text !== 'string') {
    throw new HttpError(400, 'text (string) is required')
  }
  const findings = scanContent(body.text)
  res.json({ summary: summarize(findings), findings })
}))

export default router

import { Router } from 'express'
import { asyncHandler } from '../lib/asyncHandler'
import { isAvailable, listModels } from '../ollama/client'
import { patch, read } from '../state/settings'

const router = Router()

router.get('/ollama/health', asyncHandler(async (_req, res) => {
  const available = await isAvailable()
  res.json({ available })
}))

router.get('/ollama/models', asyncHandler(async (_req, res) => {
  if (!(await isAvailable())) {
    res.json({ available: false, models: [] })
    return
  }
  const models = await listModels()
  res.json({ available: true, models })
}))

// Settings live here because they're tightly coupled to Ollama in v1. If we
// add unrelated settings later, split out into a generic /settings route.
router.get('/settings', asyncHandler((_req, res) => {
  res.json(read())
}))

router.patch('/settings', asyncHandler((req, res) => {
  const body = (req.body ?? {}) as { autoSkill?: { model?: unknown } }
  const autoSkillPatch: Partial<{ model: string }> = {}
  if (body.autoSkill && typeof body.autoSkill.model === 'string') {
    autoSkillPatch.model = body.autoSkill.model
  }
  const next = patch({ autoSkill: autoSkillPatch as { model: string } })
  res.json(next)
}))

export default router

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
  const body = (req.body ?? {}) as { harvester?: { model?: unknown } }
  const harvesterPatch: Partial<{ model: string }> = {}
  if (body.harvester && typeof body.harvester.model === 'string') {
    harvesterPatch.model = body.harvester.model
  }
  const next = patch({ harvester: harvesterPatch as { model: string } })
  res.json(next)
}))

export default router

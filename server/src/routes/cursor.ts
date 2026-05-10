import { Router } from 'express'
import { asyncHandler } from '../lib/asyncHandler'
import { computeCursorSkillUsage } from '../cursor/usage'

const router = Router()

router.get('/cursor/usage', asyncHandler((_req, res) => {
  res.json(computeCursorSkillUsage())
}))

export default router

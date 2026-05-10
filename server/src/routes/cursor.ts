import { Router } from 'express'
import { asyncHandler } from '../lib/asyncHandler'
import { computeCursorSkillUsage } from '../cursor/usage'
import { computeCursorRecentUsage } from '../cursor/recent'

const router = Router()

router.get('/cursor/usage', asyncHandler((_req, res) => {
  res.json(computeCursorSkillUsage())
}))

// Live activity from the local poller — accumulates from the moment
// polling started, independent of Cursor's fading bubble persistence.
router.get('/cursor/recent-usage', asyncHandler((_req, res) => {
  res.json(computeCursorRecentUsage())
}))

export default router

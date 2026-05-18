import os from 'os'
import { Router } from 'express'
import { asyncHandler } from '../lib/asyncHandler'
import { computeCursorSkillUsage } from '../cursor/usage'
import { computeCursorRecentUsage } from '../cursor/recent'
import { rescanAndPersist } from '../scanner/cursorProjects'
import { CURSOR_SEEN_LOG_PATH } from '../lib/paths'

const router = Router()

router.get('/cursor/usage', asyncHandler((_req, res) => {
  res.json(computeCursorSkillUsage())
}))

// Live activity from the local poller — accumulates from the moment
// polling started, independent of Cursor's fading bubble persistence.
router.get('/cursor/recent-usage', asyncHandler((_req, res) => {
  res.json(computeCursorRecentUsage())
}))

// Manual deep filesystem scan triggered by the UI's "Rescan projects"
// button. Returns the new finds so the client can toast a result. The scan
// also runs automatically once on first install via the cursor inventory
// path — this endpoint is the user-initiated equivalent for the moments
// when a brand-new project doesn't show up via Cursor's own signals.
router.post('/cursor/rescan', asyncHandler((_req, res) => {
  const { added, total } = rescanAndPersist(CURSOR_SEEN_LOG_PATH, os.homedir())
  res.json({ added, total, addedCount: added.length })
}))

export default router

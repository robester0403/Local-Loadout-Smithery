import { Router } from 'express'
import { discoverAllSkills } from '../scanner'
import { asyncHandler } from '../lib/asyncHandler'

const router = Router()

router.get('/inventory', asyncHandler((_req, res) => {
  res.json({ skills: discoverAllSkills() })
}))

export default router

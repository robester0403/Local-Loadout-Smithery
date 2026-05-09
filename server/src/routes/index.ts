// API router aggregator. Mount each domain's router under /api so the main
// server file stays focused on transport + lifecycle concerns only.

import { Router } from 'express'
import healthRouter from './health'
import inventoryRouter from './inventory'
import skillsRouter from './skills'
import uninstalledRouter from './uninstalled'
import usageRouter from './usage'
import profilesRouter from './profiles'
import superrouterRouter from './superrouter'
import mcpRouter from './mcp'
import launchClaudeRouter from './launchClaude'

const api = Router()

api.use(healthRouter)
api.use(inventoryRouter)
api.use(skillsRouter)
api.use(uninstalledRouter)
api.use(usageRouter)
api.use(profilesRouter)
api.use(superrouterRouter)
api.use(mcpRouter)
api.use(launchClaudeRouter)

// 404 for unknown API routes — must come last so it doesn't intercept the
// real handlers above.
api.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

export default api

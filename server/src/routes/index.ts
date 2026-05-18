// API router aggregator. Mount each domain's router under /api so the main
// server file stays focused on transport + lifecycle concerns only.

import { Router } from 'express'
import healthRouter from './health'
import inventoryRouter from './inventory'
import skillsRouter from './skills'
import uninstalledRouter from './uninstalled'
import usageRouter from './usage'
import profilesRouter from './profiles'
import mcpRouter from './mcp'
import cursorRouter from './cursor'
import launchClaudeRouter from './launchClaude'
import superRouterRouter from './superRouter'
import harvesterRouter from './harvester'
import ollamaRouter from './ollama'

const api = Router()

api.use(healthRouter)
api.use(inventoryRouter)
api.use(skillsRouter)
api.use(uninstalledRouter)
api.use(usageRouter)
api.use(profilesRouter)
api.use(mcpRouter)
api.use(cursorRouter)
api.use(launchClaudeRouter)
api.use(superRouterRouter)
api.use(harvesterRouter)
api.use(ollamaRouter)

// 404 for unknown API routes — must come last so it doesn't intercept the
// real handlers above.
api.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

export default api

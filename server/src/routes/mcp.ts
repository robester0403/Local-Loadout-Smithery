import { Router } from 'express'
import { buildMCPInventory, refreshMCPInventory } from '../mcp/inventory'
import { computeMCPRelationships, computeMCPUsage } from '../mcp/usage'
import { parseTimeframe, sinceDate } from '../usage/timeframe'
import { asyncHandler } from '../lib/asyncHandler'

const router = Router()

router.get('/mcp/inventory', asyncHandler(async (_req, res) => {
  const servers = await buildMCPInventory()
  res.json({ servers })
}))

router.post('/mcp/refresh', asyncHandler(async (_req, res) => {
  const servers = await refreshMCPInventory()
  res.json({ servers })
}))

router.get('/mcp/usage', asyncHandler((req, res) => {
  const tf = parseTimeframe(req.query.timeframe)
  const since = sinceDate(tf) ?? undefined
  const summaries = computeMCPUsage(since)
  res.json({ summaries })
}))

router.get('/mcp/relationships', asyncHandler((_req, res) => {
  res.json({ relationships: computeMCPRelationships() })
}))

export default router

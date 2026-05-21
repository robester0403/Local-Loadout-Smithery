import { Router } from 'express'
import { discoverAllSkills } from '../scanner/discover'
import { asyncHandler } from '../lib/asyncHandler'

const router = Router()

// Ecosystem-scoped scans so each tab only pays for its own work:
//   ?ecosystem=cursor  → only the Cursor tree
//   ?ecosystem=codex   → only the Codex tree
//   ?ecosystem=claude  → every Claude account (excludes cursor + codex)
//   (omitted)          → all accounts
//
// `?account=foo` (or `?account=foo,bar`) is the lower-level form — restricts
// to the exact account labels listed. Kept for completeness even though the
// client only uses the higher-level ecosystem param today.
router.get('/inventory', asyncHandler((req, res) => {
  const ecosystem = typeof req.query.ecosystem === 'string' ? req.query.ecosystem : ''
  if (ecosystem === 'cursor') {
    res.json({ skills: discoverAllSkills({ accounts: ['cursor'] }) })
    return
  }
  if (ecosystem === 'codex') {
    res.json({ skills: discoverAllSkills({ accounts: ['codex'] }) })
    return
  }
  if (ecosystem === 'claude') {
    res.json({ skills: discoverAllSkills({ excludeAccounts: ['cursor', 'codex'] }) })
    return
  }
  const raw = typeof req.query.account === 'string' ? req.query.account : ''
  const accounts = raw
    ? raw.split(',').map(s => s.trim()).filter(Boolean)
    : undefined
  res.json({ skills: discoverAllSkills({ accounts }) })
}))

export default router

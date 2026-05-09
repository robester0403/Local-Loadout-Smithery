import { Router } from 'express'
import { loadUninstalled, permanentDelete, restoreSkill } from '../state/uninstall'
import { asyncHandler } from '../lib/asyncHandler'
import { pathParam } from '../lib/params'

const router = Router()

router.get('/uninstalled', asyncHandler((_req, res) => {
  res.json({ entries: loadUninstalled() })
}))

router.post('/uninstalled/:id/restore', asyncHandler((req, res) => {
  const restoredPath = restoreSkill(pathParam(req, 'id'))
  res.json({ ok: true, restoredPath })
}))

router.delete('/uninstalled/:id', asyncHandler((req, res) => {
  permanentDelete(pathParam(req, 'id'))
  res.json({ ok: true })
}))

export default router

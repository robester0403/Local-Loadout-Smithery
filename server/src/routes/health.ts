import { Router } from 'express'

const router = Router()

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.0.1' })
})

export default router

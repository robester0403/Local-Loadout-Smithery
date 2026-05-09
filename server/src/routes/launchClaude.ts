import { Router } from 'express'
import { exec, spawn } from 'child_process'
import { asyncHandler } from '../lib/asyncHandler'
import { HttpError } from '../lib/paths'

const router = Router()

// macOS-specific helper that copies a prompt to the clipboard and opens a new
// Terminal window running `claude`. Other platforms get an early-return —
// users on those platforms paste manually.
router.post('/launch-claude', asyncHandler((req, res) => {
  const { prompt } = req.body as { prompt?: string }
  if (!prompt || typeof prompt !== 'string') throw new HttpError(400, 'prompt is required')

  if (process.platform !== 'darwin') {
    res.json({ ok: true, platform: 'unsupported' })
    return
  }

  const pbcopy = spawn('pbcopy')
  pbcopy.stdin.write(prompt, 'utf-8')
  pbcopy.stdin.end()
  pbcopy.on('close', (copyCode) => {
    if (copyCode !== 0) {
      res.status(500).json({ error: 'Failed to copy to clipboard' })
      return
    }
    exec(`osascript -e 'tell application "Terminal" to do script "claude"'`, (launchErr) => {
      res.json({ ok: true, platform: 'darwin', launched: !launchErr })
    })
  })
}))

export default router

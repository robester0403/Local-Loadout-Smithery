import { Router } from 'express'
import { exec, spawn } from 'child_process'
import { asyncHandler } from '../lib/asyncHandler'
import { HttpError } from '../lib/paths'

const router = Router()

function pbcopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pbcopy')
    child.on('close', code => code === 0 ? resolve() : reject(new Error('Failed to copy to clipboard')))
    child.on('error', reject)
    child.stdin.write(text, 'utf-8')
    child.stdin.end()
  })
}

function launchTerminal(): Promise<boolean> {
  return new Promise(resolve => {
    exec(`osascript -e 'tell application "Terminal" to do script "claude"'`, err => resolve(!err))
  })
}

// macOS-specific helper that copies a prompt to the clipboard and opens a new
// Terminal window running `claude`. Other platforms get an early-return —
// users on those platforms paste manually.
router.post('/launch-claude', asyncHandler(async (req, res) => {
  const { prompt } = req.body as { prompt?: string }
  if (!prompt || typeof prompt !== 'string') throw new HttpError(400, 'prompt is required')

  if (process.platform !== 'darwin') {
    res.json({ ok: true, platform: 'unsupported' })
    return
  }

  await pbcopy(prompt)
  const launched = await launchTerminal()
  res.json({ ok: true, platform: 'darwin', launched })
}))

export default router

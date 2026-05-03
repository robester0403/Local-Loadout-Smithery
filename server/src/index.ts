import express from 'express'
import path from 'path'
import os from 'os'
import { exec } from 'child_process'
import { discoverAllSkills } from './scanner'

const app = express()
const PORT = process.env.PORT || 3001

app.use(express.json())

// Serve built client in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../../client/dist')))
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0' })
})

app.get('/api/inventory', (_req, res) => {
  try {
    const skills = discoverAllSkills()
    res.json({ skills })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/skills/:id/open', (req, res) => {
  let filePath: string
  try {
    filePath = Buffer.from(req.params.id, 'base64').toString('utf-8')
  } catch {
    res.status(400).json({ error: 'Invalid id' })
    return
  }

  if (!filePath.startsWith(os.homedir())) {
    res.status(403).json({ error: 'Path outside home directory' })
    return
  }

  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
  exec(`${cmd} ${JSON.stringify(filePath)}`, (err) => {
    if (err) { res.status(500).json({ error: err.message }); return }
    res.json({ ok: true })
  })
})

app.listen(PORT, () => {
  console.log(`Local Skill Manager running at http://localhost:${PORT}`)
  if (process.env.NODE_ENV !== 'production') {
    console.log('Client dev server: http://localhost:5173')
  }
})

export default app

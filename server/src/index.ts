import express, { type Request, type Response, type NextFunction } from 'express'
import path from 'path'
import os from 'os'
import { exec } from 'child_process'
import { discoverAllSkills } from './scanner'
import { disableSkill, enableSkill } from './state'
import { computeSkillAggregate } from './usage'
import { getSampleTurn } from './usage/sampleTurn'
import { breakdownForSkill } from './usage/breakdown'
import { parseTimeframe, sinceDate } from './usage/timeframe'

const app = express()
const PORT = process.env.PORT || 3001

app.use(express.json())

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

app.get('/api/usage/aggregate', (req, res) => {
  try {
    const tf = parseTimeframe(req.query['timeframe'])
    const since = sinceDate(tf) ?? undefined
    const summaries = computeSkillAggregate(undefined, since)
    res.json({ summaries })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/skills/:id/disable', (req, res) => {
  try {
    disableSkill(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/skills/:id/enable', (req, res) => {
  try {
    enableSkill(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.get('/api/usage/sample-turn', (req, res) => {
  try {
    const tf = parseTimeframe(req.query['timeframe'])
    const since = sinceDate(tf) ?? undefined
    const sample = getSampleTurn(since)
    res.json({ sample })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.get('/api/usage/breakdown/:skillId', (req, res) => {
  let filePath: string
  try {
    filePath = Buffer.from(req.params.skillId, 'base64').toString('utf-8')
  } catch {
    res.status(400).json({ error: 'Invalid skillId' })
    return
  }

  const home = os.homedir()
  const normalized = path.resolve(filePath)
  if (normalized !== home && !normalized.startsWith(home + path.sep)) {
    res.status(403).json({ error: 'Path outside home directory' })
    return
  }

  const allSkills = discoverAllSkills()
  const skill =
    allSkills.find(s => s.path === filePath) ||
    allSkills.find(s => s.path === filePath + '.disabled') ||
    allSkills.find(s => s.path.replace(/\.disabled$/, '') === filePath) ||
    allSkills.find(s => s.realpath === normalized)

  if (!skill) {
    res.status(404).json({ error: 'Skill not found' })
    return
  }

  try {
    const tf = parseTimeframe(req.query['timeframe'])
    const since = sinceDate(tf) ?? undefined
    const breakdown = breakdownForSkill(skill.name, skill.description, skill.type, 100, since)
    res.json({ breakdown })
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

  const home = os.homedir()
  const normalized = path.resolve(filePath)
  if (normalized !== home && !normalized.startsWith(home + path.sep)) {
    res.status(403).json({ error: 'Path outside home directory' })
    return
  }

  let cmd: string
  if (process.platform === 'darwin') cmd = 'open'
  else if (process.platform === 'win32') cmd = 'start ""'
  else cmd = 'xdg-open'

  exec(`${cmd} ${JSON.stringify(filePath)}`, (err) => {
    if (err) { res.status(500).json({ error: err.message }); return }
    res.json({ ok: true })
  })
})

// 404 for unknown API routes (must be before static fallback)
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// In production, serve the SPA for any non-API route
if (process.env.NODE_ENV === 'production') {
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '../../client/dist/index.html'))
  })
}

// Global error handler — catches anything thrown by middleware/routes
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[LSM]', err.message)
  res.status(500).json({ error: err.message })
})

app.listen(PORT, () => {
  const line = '─'.repeat(44)
  console.log(`\n\x1b[36m┌${line}┐\x1b[0m`)
  console.log(`\x1b[36m│\x1b[0m  \x1b[1mLocal Skill Manager\x1b[0m                        \x1b[36m│\x1b[0m`)
  console.log(`\x1b[36m│\x1b[0m  API server  →  http://localhost:${PORT}           \x1b[36m│\x1b[0m`)
  if (process.env.NODE_ENV !== 'production') {
    console.log(`\x1b[36m│\x1b[0m  \x1b[1m\x1b[32mOpen in browser → http://localhost:5173\x1b[0m     \x1b[36m│\x1b[0m`)
  }
  console.log(`\x1b[36m└${line}┘\x1b[0m\n`)
})

export default app

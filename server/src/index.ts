import express from 'express'
import path from 'path'
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

app.listen(PORT, () => {
  console.log(`Local Skill Manager running at http://localhost:${PORT}`)
  if (process.env.NODE_ENV !== 'production') {
    console.log('Client dev server: http://localhost:5173')
  }
})

export default app

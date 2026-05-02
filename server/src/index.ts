import express from 'express'
import path from 'path'

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

// Placeholder — inventory endpoint added in P2.8
app.get('/api/inventory', (_req, res) => {
  res.json({ skills: [], message: 'Scanner not yet implemented' })
})

app.listen(PORT, () => {
  console.log(`Local Skill Manager running at http://localhost:${PORT}`)
  if (process.env.NODE_ENV !== 'production') {
    console.log('Client dev server: http://localhost:5173')
  }
})

export default app

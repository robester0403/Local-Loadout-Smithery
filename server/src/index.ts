// Transport + lifecycle wiring only. Route handlers live under ./routes/.

import express, { type NextFunction, type Request, type Response } from 'express'
import path from 'path'
import api from './routes'
import { countTokens } from './usage/tokenizer'

// Warm up the tokenizer — builds the cached Tiktoken instance at startup,
// not on first request.
countTokens('warmup')

const app = express()
const PORT = process.env.PORT || 4123

app.use(express.json())

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../../client/dist')))
}

// All API routes mount under /api. The aggregator handles its own 404 fallback
// so unknown /api paths don't fall through to the SPA index.html below.
app.use('/api', api)

// In production, serve the SPA for any non-API route.
if (process.env.NODE_ENV === 'production') {
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '../../client/dist/index.html'))
  })
}

// Global error handler — last line of defense for anything thrown past the
// per-route asyncHandler.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[loadoutsmith]', err.message)
  if (!res.headersSent) res.status(500).json({ error: err.message })
})

const server = app.listen(PORT, () => {
  const line = '─'.repeat(44)
  console.log(`\n\x1b[36m┌${line}┐\x1b[0m`)
  console.log(`\x1b[36m│\x1b[0m  \x1b[1mLocal Loadout Smithery\x1b[0m                     \x1b[36m│\x1b[0m`)
  console.log(`\x1b[36m│\x1b[0m  API server  →  http://localhost:${PORT}           \x1b[36m│\x1b[0m`)
  if (process.env.NODE_ENV !== 'production') {
    console.log(`\x1b[36m│\x1b[0m  \x1b[1m\x1b[32mOpen in browser → http://localhost:5173\x1b[0m     \x1b[36m│\x1b[0m`)
  }
  console.log(`\x1b[36m└${line}┘\x1b[0m\n`)
})

function shutdown(signal: NodeJS.Signals) {
  console.log(`\n[loadoutsmith] received ${signal}, shutting down…`)
  server.close(() => process.exit(0))
  // Force-exit if any open keep-alive connection holds the server open.
  setTimeout(() => process.exit(0), 1000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

export default app

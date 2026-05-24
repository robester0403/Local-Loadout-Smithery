import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { runExtraction } from '../extractors'
import { readSentinel, writeSentinel } from '../extractors/store'

// We test the `forceReextract` flag's effect on `since` by stubbing the
// per-source extractor functions. The real extractors hit disk/sqlite and
// aren't necessary to exercise the hwm-bypass logic.

// Spy targets — we don't replace the modules; we capture the `since` arg
// each extractor receives and return an empty record list.
const capturedSince: { claude?: number; cursor?: number; codex?: number } = {}

vi.mock('../extractors/claudeCode', () => ({
  extractClaudeConversations: (since: number) => {
    capturedSince.claude = since
    return { records: [], warnings: [], newHighWaterMark: since }
  },
  extractClaudeConversationById: () => null,
}))
vi.mock('../extractors/cursor', () => ({
  extractCursorConversations: (since: number) => {
    capturedSince.cursor = since
    return { records: [], warnings: [], newHighWaterMark: since }
  },
  extractCursorConversationById: () => null,
}))
vi.mock('../extractors/codex', () => ({
  extractCodexConversations: (since: number) => {
    capturedSince.codex = since
    return { records: [], warnings: [], newHighWaterMark: since }
  },
  extractCodexConversationById: () => null,
}))

let tmpHome: string
let realHomedir: () => string

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-extract-'))
  realHomedir = os.homedir
  ;(os as { homedir: () => string }).homedir = () => tmpHome
  capturedSince.claude = undefined
  capturedSince.cursor = undefined
  capturedSince.codex = undefined
})

afterEach(() => {
  ;(os as { homedir: () => string }).homedir = realHomedir
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('runExtraction forceReextract', () => {
  it('default path: since = max(hwm, lookbackFloor)', () => {
    // Seed hwm to 5 days ago.
    const now = Date.now()
    const hwmMs = now - 5 * 24 * 60 * 60 * 1000
    writeSentinel({
      highWaterMark: { claude: hwmMs, cursor: hwmMs, codex: hwmMs },
      lastRunAt: new Date(now).toISOString(),
    })

    // Lookback 14 days → floor is 14 days ago, hwm is 5 days ago → max = hwm.
    runExtraction({ lookbackDays: 14 })

    // Each extractor should receive `since = hwm` (the more recent of the two).
    expect(capturedSince.claude).toBe(hwmMs)
    expect(capturedSince.cursor).toBe(hwmMs)
    expect(capturedSince.codex).toBe(hwmMs)
  })

  it('forceReextract: since = lookbackFloor regardless of hwm', () => {
    const now = Date.now()
    // hwm is recent — would normally clamp `since` to (now - 0.1s).
    writeSentinel({
      highWaterMark: { claude: now - 100, cursor: now - 100, codex: now - 100 },
      lastRunAt: new Date(now).toISOString(),
    })

    runExtraction({ lookbackDays: 7, forceReextract: true })

    // With forceReextract, `since` ignores hwm and uses lookbackFloor.
    const lookbackFloor = Date.now() - 7 * 24 * 60 * 60 * 1000
    // Small tolerance for the millisecond drift between writeSentinel + Date.now.
    expect(capturedSince.claude).toBeGreaterThanOrEqual(lookbackFloor - 1000)
    expect(capturedSince.claude).toBeLessThanOrEqual(lookbackFloor + 1000)
    // Crucially: `since` is FAR earlier than the recent hwm — confirms the bypass.
    expect(capturedSince.claude!).toBeLessThan(now - 100)
  })

  it('forceReextract: sentinel does NOT regress (next non-forced run resumes normally)', () => {
    const now = Date.now()
    const originalHwm = now - 100 // very recent
    writeSentinel({
      highWaterMark: { claude: originalHwm, cursor: originalHwm, codex: originalHwm },
      lastRunAt: new Date(now).toISOString(),
    })

    runExtraction({ lookbackDays: 14, forceReextract: true })

    // After the forced run, hwm should be at least as high as before.
    // Our mocks return newHwm = since (the lookbackFloor for forced runs),
    // which is way OLDER than originalHwm — but max(old, new) keeps original.
    const after = readSentinel()
    expect(after.highWaterMark.claude).toBe(originalHwm)
    expect(after.highWaterMark.cursor).toBe(originalHwm)
    expect(after.highWaterMark.codex).toBe(originalHwm)
  })

  it('forceReextract respects the sources filter', () => {
    const now = Date.now()
    writeSentinel({
      highWaterMark: { claude: now - 100, cursor: now - 100, codex: now - 100 },
      lastRunAt: new Date(now).toISOString(),
    })

    runExtraction({ lookbackDays: 14, forceReextract: true, sources: ['claude'] })

    expect(capturedSince.claude).toBeDefined()
    expect(capturedSince.cursor).toBeUndefined()
    expect(capturedSince.codex).toBeUndefined()
  })

  it('forceReextract: false is treated like default (sanity)', () => {
    const now = Date.now()
    const hwmMs = now - 5 * 24 * 60 * 60 * 1000
    writeSentinel({
      highWaterMark: { claude: hwmMs, cursor: hwmMs, codex: hwmMs },
      lastRunAt: new Date(now).toISOString(),
    })

    runExtraction({ lookbackDays: 14, forceReextract: false })

    expect(capturedSince.claude).toBe(hwmMs)
  })
})

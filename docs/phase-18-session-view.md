# Phase 18 — Session-centric view

Add a first-class "session" entity alongside the existing skill-centric model. Skill cost answers "which skills are expensive"; session cost answers "which conversations are expensive" — a different and complementary cross-section.

## Background

Skill cost is the right primitive for inventory management ("should I keep this skill?"). Session cost is the right primitive for spend management ("which conversations blew the budget?"). They overlap but answer different questions.

JSONL data already in hand:
- `sessionId` — UUID grouping all turns in a conversation
- `cwd` — project directory at turn time (often same throughout a session)
- `gitBranch` — git branch at turn time
- `timestamp` — first/last turn give session duration
- All turn-level cost data already computed

## Files to read first

```
server/src/usage/parser.ts          — UsageTurn shape + parser
server/src/usage/attributor.ts      — model for skill state machine
server/src/usage/aggregate.ts       — current SkillCostSummary
client/src/App.tsx                  — current ActiveTab type
client/src/components/SuperRouterTab.tsx — example of a non-inventory tab
docs/cost-calculations.md           — cost model reference
```

---

## Phase A — Backend: session aggregation

### A1. New file: `server/src/usage/sessions.ts`

```typescript
export interface SessionSummary {
  sessionId: string
  startTs: string
  endTs: string
  durationMinutes: number   // (endTs - startTs) / 60_000
  turnCount: number
  cwd: string               // most-common cwd (sessions can move between dirs)
  gitBranch: string         // most-common branch
  modelMix: Record<string, { turns: number; dollars: number }>
  skillsUsed: string[]      // distinct skill names invoked in this session
  inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens: number
  totalDollars: number
}

export function computeSessionCosts(since?: Date): SessionSummary[]
```

### A2. Algorithm

Walk all session JSONLs (reuse `findSessionFiles()`). For each file (one file ≈ one session, but verify):

1. Track per-session aggregates: turn count, first/last timestamp, mode of `cwd` and `gitBranch`, set of skill names from `<command-message>`, model usage counts, token totals.
2. Compute `totalDollars` from `getPricing(model)` × tokens for each turn.
3. Filter by `since` against the session's `endTs` (if a session ends after `since`, include it; if it ended before, drop). This matches user intent: "show me sessions in the last week" means "sessions that had activity in the last week."
4. Return sorted by `totalDollars` descending.

**Verify "one file = one session" assumption.** Spot-check: `grep -l '"sessionId"' a-jsonl-file` and confirm only one unique sessionId per file. If sessions can span files (very unlikely but possible), aggregate by sessionId across files.

### A3. Route

```typescript
app.get('/api/usage/sessions', (req, res) => {
  try {
    const tf = parseTimeframe(req.query.timeframe)
    const since = sinceDate(tf) ?? undefined
    res.json({ sessions: computeSessionCosts(since) })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})
```

### A4. Tests

`server/src/__tests__/sessions.test.ts`:

- Single session, three turns, one model → one summary entry, sum matches.
- Two sessions in two files → two summaries, no cross-contamination.
- Session with multiple skills used → `skillsUsed` contains all.
- Session with multi-model usage → `modelMix` populated correctly.
- `since` filter excludes sessions whose `endTs < since`.
- Session with `cwd` changes mid-session → most-common `cwd` wins.

---

## Phase B — Frontend: Sessions tab

### B1. Add tab type

In `client/src/App.tsx`:

```typescript
type ActiveTab = 'inventory' | 'superrouter' | 'sessions'
```

Add tab button alongside Inventory and SuperRouter.

### B2. New component: `client/src/components/SessionsTab.tsx`

Layout:
- Top: summary cards — total spend, total sessions, avg session cost, longest session, most expensive session.
- Table:
  - Date (start ts, friendly format)
  - Duration
  - Project (last segment of cwd)
  - Branch
  - Skills used (badge cluster, max 3 visible + "+N")
  - Models (badges with relative percent)
  - Turns
  - Cost ($)
- Click a row → drawer or modal with full session detail (turn-by-turn breakdown? Or just expanded summary?). For Phase 18, just expanded summary; turn-level breakdown is Phase 19's tool-bloat work.

Sort by cost descending by default. Allow sort by date, duration, turns, cost.

### B3. Filter integration

Reuse the existing `TimeframePicker`. Sessions tab respects the same global timeframe as the inventory.

### B4. API hookup

Add `fetchSessionCosts(timeframe)` to `client/src/api.ts`. Load on tab activation; refresh on timeframe change.

---

## Phase C — Verify

1. `npm test` — green, new session tests included.
2. Both `tsc --noEmit` clean.
3. Curl: `curl -s 'localhost:3001/api/usage/sessions?timeframe=week' | jq '.sessions | length'` — expect a non-zero number reflecting your week's sessions.
4. UI: navigate to Sessions tab, verify the top session matches your memory of the most expensive recent conversation. Verify skill badges resolve correctly (not phantom names).
5. Cross-check totals: sum of all session `totalDollars` should ≈ total skill spend (active) + unattributed turns. Slight differences are OK (loaded cost lives elsewhere) but order of magnitude must match.

## Constraints

- Don't recompute skill cost in this phase — just aggregate independently from the JSONL.
- Sessions tab must not slow inventory tab loads — load session data only when tab is active.
- Match existing styling (sidebar, header, etc.) — use existing CSS classes where possible.

## Risk notes

- **`cwd` changes mid-session.** Some sessions move between projects (rare). The "most-common cwd" simplification is good enough; flag in the UI if `cwd` varied.
- **Long-tail sessions.** A user with 1000+ sessions over a year will produce a big response. Pagination not needed for `'all'` since we cap at recent timeframes by default, but watch payload size — if > 1 MB, paginate or truncate to top-N.
- **Session count vs cost prioritization.** The top of the list will be expensive sessions, but most users care equally about *frequent cheap* patterns ("I run morning-plan every day, costs add up"). Consider a secondary view aggregated by `cwd + gitBranch` to surface that. Out of scope for Phase 18; note for Phase 20.

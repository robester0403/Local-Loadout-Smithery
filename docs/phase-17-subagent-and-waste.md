# Phase 17 — Subagent attribution + waste tracking

Two unmeasured cost categories that are currently invisible or mis-attributed:

1. **Subagent (sidechain) cost** — turns spawned by the `Task` tool run in their own context with no `<command-name>` triggering them. Currently they're either invisible (parent had no active skill) or wrongly billed to whatever skill happened to be active in the parent thread.
2. **Wasted spend** — turns that errored mid-stream (`apiErrorStatus`) or got cut off (`stop_reason: max_tokens`) still bill input tokens. Today these are silently included in normal cost; surfacing them lets the user see how much they're paying for failed runs.

## Background

JSONL fields involved (verified via direct inspection of `~/.claude/projects/**/*.jsonl`):

- `isSidechain: true` — top-level field marking subagent turns. Subagents have their own `parentUuid` chain rooted at the Task invocation.
- `apiErrorStatus`, `isApiErrorMessage`, `error` — top-level fields on failed turns. Failed turns still include a `usage` object with the input tokens consumed before failure.
- `message.stop_reason` — `'end_turn' | 'tool_use' | 'max_tokens' | 'pause_turn'`. `max_tokens` = the model ran out of output budget; almost always a failure mode worth surfacing.

## Files to read first

```
server/src/usage/attributor.ts     — current active cost; mis-attributes sidechains
server/src/usage/loaded.ts         — loaded cost ignores sidechain (correct — listing not re-injected)
server/src/usage/aggregate.ts      — combines into SkillCostSummary
server/src/usage/types.ts          — UsageTurn shape — needs new fields
server/src/usage/parser.ts         — extend turn parsing to capture sidechain + error fields
docs/cost-calculations.md          — accuracy framework (Active cost > Caveats)
```

---

## Phase A — Backend: capture new fields

### A1. Extend `UsageTurn`

In `server/src/usage/types.ts`:

```typescript
export interface UsageTurn {
  // ... existing fields
  isSidechain: boolean
  parentUuid: string
  stopReason: string  // '' if missing
  errored: boolean    // apiErrorStatus set OR isApiErrorMessage true
}
```

### A2. Update `parser.ts → parseSessionFile`

Read these from each assistant turn:
- `isSidechain` → boolean (default false)
- `parentUuid` → string (default '')
- `message.stop_reason` → string
- `apiErrorStatus` truthy OR `isApiErrorMessage === true` → `errored: true`

### A3. Update `attributor.ts` to handle sidechains

In `parseSessionActiveCost`, sidechain turns appear interleaved with main-thread turns. The current state machine doesn't know they exist and mis-attributes them.

Options considered:
- **A — exclude sidechains from active cost entirely.** Simple. They become a separate accumulator (Phase A4 below). Loses the link to triggering skill.
- **B — attribute sidechains to whatever skill was active in their parent thread at spawn time.** More useful; preserves the cost relationship. Requires tracking parent-thread `currentSkill` separately when a `Task` tool_use appears.

Pick **B**. Implementation:

1. Add a second state-machine layer: when an assistant turn contains a `tool_use` with `name === 'Task'`, record the spawn time and current `currentSkill` keyed by the tool_use's `id`.
2. When a subsequent assistant turn has `isSidechain: true` and its `parentUuid` chain (or session correlation — investigate which is reliable) traces back to that Task tool_use, attribute it to the recorded skill.
3. Tag the attribution as sidechain so it can be reported separately.

### A4. New accumulator: sidechain cost per skill

Extend `ActiveCostEntry`:

```typescript
export interface ActiveCostEntry {
  // ... existing
  sidechainTokens: number
  sidechainDollars: number
}
```

Or add a separate function `computeSidechainCost(...)` returning a parallel structure. Pick separate function — cleaner and lets the UI show sidechain as its own column without conflating with direct active cost.

```typescript
export interface SidechainCostEntry {
  parentSkillName: string
  invocations: number   // how many Task spawns
  inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens: number
  totalDollars: number
}

export function computeSidechainCost(validSkills?: Set<string>, since?: Date): SidechainCostEntry[]
```

### A5. Waste accumulator

```typescript
export interface WasteEntry {
  skillName: string         // attributed via the same currentSkill state machine
  erroredTurns: number
  maxTokensTurns: number
  wastedDollars: number     // sum of erroredTurns + maxTokensTurns dollars
}

export function computeWasteCost(validSkills?: Set<string>, since?: Date): WasteEntry[]
```

`max_tokens` turns produced *some* output — they're not 100% wasted, but the cutoff usually means the assistant didn't finish the task and the user reran it. Treat as waste; document the reasoning.

Errored turns ARE 100% wasted on the input side. Some have partial output tokens (streamed before the error) — include them in the wasted dollars too.

### A6. Routes

```typescript
app.get('/api/usage/sidechains', (req, res) => {
  const tf = parseTimeframe(req.query.timeframe)
  const since = sinceDate(tf) ?? undefined
  res.json({ entries: computeSidechainCost(undefined, since) })
})

app.get('/api/usage/waste', (req, res) => {
  const tf = parseTimeframe(req.query.timeframe)
  const since = sinceDate(tf) ?? undefined
  res.json({ entries: computeWasteCost(undefined, since) })
})
```

### A7. Tests

In `server/src/__tests__/`:

- `sidechain.test.ts`:
  - User invokes skill A, assistant calls `Task` tool, sidechain turn follows → attributed to skill A.
  - Two skills, each spawns Task — sidechain attribution doesn't cross-contaminate.
  - Sidechain turn with no traceable parent skill → goes into a `'<unattributed>'` bucket (don't drop silently).

- `waste.test.ts`:
  - Errored turn with input_tokens > 0 → `wastedDollars > 0`, `erroredTurns === 1`.
  - `max_tokens` turn → `maxTokensTurns === 1`, dollars include both input and output.
  - Healthy turns don't appear.

---

## Phase B — Frontend

### B1. `client/src/api.ts`

Add `fetchSidechainCost(timeframe)` and `fetchWasteCost(timeframe)` matching the existing `fetchUsageAggregate` pattern.

### B2. New columns in inventory table?

**Don't add columns by default.** Subagent and waste are interesting but rarely the headline. Two options:

- **Detail drawer accordion sections.** "Sidechain cost: $X across N spawns" and "Wasted spend: $Y across N errored turns + M cutoffs" inside each skill's drawer.
- **Optional inventory columns** behind a toggle in the filter bar: "Show subagent / waste columns."

Pick the drawer-only approach for Phase 17. Inventory columns can come later if the data turns out to be load-bearing.

### B3. Header banner for waste

If total wasted spend > $X (configurable threshold, default $1) over the active timeframe, surface a banner at the top of the inventory:

```
⚠ $4.23 wasted on 12 errored turns and 8 cutoffs this week. Top skill: …
```

Click → filter inventory to skills with wasted > 0.

### B4. Aggregate top-line

The header total ("$X total") today sums active + loaded. Should it include sidechain? Should it subtract waste?

Pick: **add sidechain to total (it's real spend), do NOT subtract waste (also real spend, just badly used).** Add a tooltip explanation:

```
Total $X = Active $A + Loaded $L + Sidechain $S
of which $W was wasted on errors/cutoffs
```

---

## Phase C — Verify

1. `npm test` — all new tests + existing 123 stay green.
2. Manual: pick a session you remember spawning subagents (search transcripts for `"isSidechain":true`). Verify the cost numbers attribute to the right parent skill.
3. Pick a session you remember erroring out (look for `apiErrorStatus`). Verify the wasted dollars match what you'd expect.
4. Header total should be ≥ previous total (we're adding a category, not redistributing).

## Constraints

- Don't double-count. Sidechain turns must NOT also appear in the standard active cost — they're either-or, not both. Add a regression test for this.
- Backwards compat: existing `/api/usage/aggregate` endpoint output shape stays the same. Sidechain and waste are separate endpoints. Frontend assembles the combined view.
- Loaded cost is unaffected by sidechains — subagents inherit context from the parent (no new listing injection per spawn). Don't change `loaded.ts`.

## Risk notes

- **Sidechain → parent skill linkage may not be reliable** depending on what the JSONL records. The `parentUuid` chain on sidechain turns might not directly reference the Task tool_use's `id`; it might reference a different boundary. Spend the first hour spiking on real session data before implementing — if the linkage is unreliable, fall back to attributing sidechains by `sessionId` time-windowed against the most recent skill in that session.
- **`max_tokens` isn't always waste.** A long file dump that exactly fills the output budget is a successful turn. The user might disagree that it's "wasted." Make the categorization configurable later if pushback.
- **Errored turns may have stale `currentSkill` attribution.** If the user ran a skill, it errored, then they ran another skill, we'd attribute the error to the first. That's correct — the first skill DID cost money before failing.

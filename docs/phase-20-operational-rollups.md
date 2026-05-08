# Phase 20 — Operational rollups

Aggregations and trend visualizations that don't fit the per-skill model. The "what's my burn rate" and "where am I spending" questions a budget holder asks.

## Background

After Phases 15–19 the data model is solid. Phase 20 doesn't change the model — it surfaces existing data through new aggregations:

- **Daily/weekly burn rate** with delta vs previous period
- **Cache efficiency** per skill (cache_read fraction)
- **Model mix** breakdown (Opus / Sonnet / Haiku spend)
- **Per-project** rollup (group by `cwd`)
- **Per-branch** rollup (group by `gitBranch`)
- **Cost per invocation** (mean) per skill — outlier detection
- **Output efficiency** (output_tokens / input_tokens) per skill

Everything here is computable from existing parsed data. No new fields needed beyond what Phase 17 already added (`isSidechain`, `errored`, `stopReason`).

## Files to read first

```
server/src/usage/parser.ts          — UsageTurn (post Phase 17 has all needed fields)
server/src/usage/aggregate.ts       — pattern for computing summaries
client/src/App.tsx                  — header layout, tab structure
docs/cost-calculations.md           — accuracy framework
```

---

## Phase A — Backend: rollups

### A1. New file: `server/src/usage/rollups.ts`

Five exported functions, all backed by a single shared walk over `parseAllSessions()` output:

```typescript
export interface DailyBurn {
  date: string              // YYYY-MM-DD
  dollars: number
  turns: number
  sessions: number
}
export function computeDailyBurn(since?: Date): DailyBurn[]

export interface ModelMix {
  model: string
  turns: number
  dollars: number
  pctOfTotal: number
}
export function computeModelMix(since?: Date): ModelMix[]

export interface ProjectRollup {
  cwd: string
  projectName: string       // last path segment
  sessions: number
  turns: number
  dollars: number
  topSkills: string[]       // 3 most-invoked skill names
}
export function computeProjectRollup(since?: Date): ProjectRollup[]

export interface BranchRollup {
  cwd: string
  gitBranch: string
  turns: number
  dollars: number
}
export function computeBranchRollup(since?: Date): BranchRollup[]

export interface CacheEfficiency {
  skillName: string
  invocations: number
  cacheReadTokens: number
  cacheCreationTokens: number
  uncachedInputTokens: number
  cacheHitRate: number      // cacheRead / (cacheRead + cacheCreate + input)
}
export function computeCacheEfficiency(since?: Date): CacheEfficiency[]
```

### A2. Single-walk implementation

All five aggregations run in one pass over `parseAllSessions().turns`. Don't read JSONLs five times.

```typescript
function singlePassRollups(since?: Date): {
  daily: DailyBurn[]
  modelMix: ModelMix[]
  project: ProjectRollup[]
  branch: BranchRollup[]
  cacheEff: CacheEfficiency[]
}
```

The five public functions wrap this and return their slice.

### A3. Outlier detection helper

Add to `aggregate.ts` or a new `outliers.ts`:

```typescript
export interface SkillOutlier {
  skillName: string
  meanDollarsPerInvocation: number
  globalMean: number
  zScore: number
  flag: 'high' | 'low' | null  // |z| > 2
}
export function computeSkillOutliers(since?: Date): SkillOutlier[]
```

### A4. Routes

```typescript
app.get('/api/usage/burn', /* daily */)
app.get('/api/usage/models', /* model mix */)
app.get('/api/usage/projects', /* per-cwd */)
app.get('/api/usage/branches', /* per-branch */)
app.get('/api/usage/cache', /* cache efficiency per skill */)
app.get('/api/usage/outliers', /* mean cost per invocation flags */)
```

Or one consolidated `app.get('/api/usage/rollups')` returning all five. Pick consolidated — the frontend needs them all on the dashboard anyway, and one round-trip is cleaner.

### A5. Tests

`server/src/__tests__/rollups.test.ts`:

- Burn: 3 turns across 2 days → 2 DailyBurn entries with correct sums.
- Model mix: turns split across two models → `pctOfTotal` sums to 100.
- Project rollup: turns from two cwds → two entries; `topSkills` derived from each cwd's most-invoked.
- Branch: same cwd, two branches → two entries.
- Cache eff: turn with `cache_read=900, cache_create=100, input=0` → hit rate = 90%.
- Outlier: skill with mean $1 vs global mean $0.05 → flagged 'high'.

---

## Phase B — Frontend: Dashboard tab

### B1. Add tab

```typescript
type ActiveTab = 'inventory' | 'superrouter' | 'sessions' | 'dashboard'
```

### B2. New component: `client/src/components/DashboardTab.tsx`

Layout (top to bottom):

1. **Burn rate strip** — three numbers + sparkline:
   - Today's spend ($X)
   - This week ($Y, ±Z% vs last week)
   - This month ($W, ±V% vs previous month)
   - Sparkline: last 30 days bars

2. **Model mix donut** — small pie/donut showing Opus/Sonnet/Haiku spend split. Hover = exact dollars.

3. **Top-N panels** — three side-by-side panels:
   - Top 5 projects by spend (`computeProjectRollup`)
   - Top 5 sessions by spend (Phase 18 data)
   - Top 5 outlier skills (`computeSkillOutliers`, flagged 'high')

4. **Cache efficiency table** — skill name | hit rate (% bar) | wasted-cache-create dollars (computed = `cache_create $ — typical cache_create $`). Sort by waste descending.

5. **Branch leaderboard** (collapsible) — for users who want it. Rows = `(project, branch)` tuples sorted by spend. Most users won't care; hide behind an accordion.

### B3. Recharts vs hand-rolled

Avoid new dependencies if possible. Bars and sparklines can be hand-rolled with CSS/SVG. Donut is the only mildly painful one — either build it from SVG arcs or skip the donut and use a horizontal stacked bar instead.

Pick: **no new dependencies**. Use horizontal stacked bar for model mix; sparkline as a 30-element SVG line.

### B4. Header total update

The header total today shows `Total $X = Active + Loaded`. After Phase 17 it includes Sidechain. After Phase 20 add a tooltip with the rollup view link. No display change.

---

## Phase C — Verify

1. `npm test` — green.
2. Both `tsc --noEmit` clean.
3. Curl `localhost:3001/api/usage/rollups?timeframe=month | jq '.daily[-7:]'` — last 7 days of burn rate, eyeball against your memory.
4. Dashboard tab loads in <500 ms (single-pass walk should be fast).
5. Click through each panel — all numbers should be internally consistent (model mix percentages sum to 100, project totals roughly equal sum of session totals minus loaded cost, etc.).

## Constraints

- Single-walk for all five aggregations. Don't re-parse JSONLs five times.
- No new dependencies (no chart libraries).
- Dashboard data refreshes on tab activation and timeframe change. Not on the 30-second interval (would be overkill).
- Reuse existing CSS classes; don't introduce a new design system.

## Risk notes

- **`gitBranch` may be empty** for sessions outside git repos. Group those under `(no branch)` rather than dropping them.
- **`cwd` cardinality.** A power user may have 50+ projects. Cap project rollup display to top 10; provide "show all" expander.
- **Model mix percentages** — small sample sizes (e.g., one Opus turn out of 200) produce misleading percentages. Show absolute counts alongside percentages.
- **Outlier z-scores** require at least ~5 skills with invocations to be meaningful. If fewer, hide the outlier panel.
- **Cache hit rate denominator includes `cache_create`** — fresh sessions will have low rates by construction (you have to write the cache before reading it). Average over a longer timeframe to see steady-state behavior. Document this in the panel tooltip.

## Sequencing note

Phase 20 should land last. It depends on:
- Phase 15 (clean loaded numbers)
- Phase 17 (`isSidechain`, `errored` fields parsed and excluded from headline rollups)
- Phase 18 (session counts feed into the burn-rate session count)

Phase 16 and Phase 19 are independent and can land in any order before Phase 20.

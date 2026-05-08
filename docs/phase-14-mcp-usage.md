# Phase 14 — Surface MCP usage in the inventory

Phase 13 added MCP server rows to the inventory table. They currently show "—" for cost columns, Modified, and Enabled. This phase wires real MCP usage data into the table, the detail drawer, and the relationship map.

## Architecture context (for the implementer)

- Session logs: `~/.claude/projects/**/*.jsonl`. One JSON object per line.
- Assistant turns: `message.usage` has token counts; `message.content` is an array that may contain `{type: "tool_use", name: "mcp__<server>__<tool>"}` blocks.
- User turns: `message.content` is a string; skill invocations include `<command-name>` and `<command-message>` tags.
- Existing usage pipeline lives in `server/src/usage/` (parser, attributor, loaded, aggregate, pricing, timeframe).
- Existing MCP pipeline lives in `server/src/mcp/` (inventory, sessionInjected, types).

## Important corrections to the original brief

- Timeframe helper is `sinceDate()` / `parseTimeframe()` in `server/src/usage/timeframe.ts`. The brief mentioned `toSinceDate()` — that does not exist.
- `parser.ts` already extracts `toolUses[]` per assistant turn from `tool_use` blocks. Use that instead of regex-scanning raw JSON for the cost path. Reserve the `MCP_RE` regex for splitting `mcp__server__tool` names.
- `MCP_RE` in `server/src/mcp/sessionInjected.ts` is currently module-local. Export it before reusing.

## Files to read first

```
server/src/usage/parser.ts        — UsageTurn, parseAllSessions, findSessionFiles, extractToolUses
server/src/usage/attributor.ts    — reference model for skill-active state machine
server/src/usage/pricing.ts       — getPricing(), toDollars()
server/src/usage/timeframe.ts     — sinceDate(), parseTimeframe()
server/src/usage/types.ts         — UsageTurn
server/src/mcp/types.ts           — MCPServerEntry, MCPTool
server/src/mcp/inventory.ts       — buildMCPInventory()
server/src/mcp/sessionInjected.ts — MCP_RE regex
server/src/index.ts               — route registration (~line 525 for MCP block)
client/src/App.tsx                — load(), toMCPSkill(), Promise.all
client/src/components/DetailDrawer.tsx — MCP isMCP branch
client/src/components/InventoryTable.tsx — MCP row "—" hardcoding
client/src/api.ts                 — fetchMCPInventory, parseResponse pattern
client/src/types.ts               — MCPRow, MCPTool, Skill
```

---

## Phase A — Backend usage aggregation

### A1. New file: `server/src/mcp/usage.ts`

Export the following types:

```typescript
export interface MCPToolUsage {
  name: string
  calls: number
  lastInvoked: string
}
export interface MCPUsageSummary {
  serverName: string
  invocations: number
  lastInvoked: string
  tokens: number
  dollars: number
  tools: MCPToolUsage[]
}
export interface MCPRelationship {
  skillName: string
  serverName: string
  calls: number
}
```

Export `MCP_RE` from `sessionInjected.ts` so this file can reuse it. Do not redefine the regex.

Implement a single private session walker so usage + relationships only read every JSONL once:

```typescript
function walkMCPSessions(
  since: Date | undefined,
  onAssistantTurn: (turn: { ts: string; model: string; usage: TokenCounts; mcpToolNames: string[]; currentSkill: string | null }) => void,
): void
```

The walker mirrors the state-machine in `attributor.ts`:
- Maintain `currentSkill: string | null`.
- On user turn with `<command-name>`: parse `<command-message>`, set `currentSkill = name` if `validSkills.has(name)`, else `currentSkill = null`.
- On assistant turn: extract `tool_use` blocks (reuse the same logic as `parser.extractToolUses` — refactor it to be exported, or duplicate it inline if cleaner). Filter names matching `MCP_RE` and emit `{ts, model, usage, mcpToolNames, currentSkill}` to the callback.
- Honor the `since` filter against the assistant-turn timestamp.
- `validSkills` comes from `discoverAllSkills()` (same source attributor uses).

Then implement the two public functions on top of the walker:

**`computeMCPUsage(since?: Date): MCPUsageSummary[]`**

For each emitted assistant turn:
- Split each `mcp__server__tool` name via `MCP_RE` into `(server, tool)`.
- Build a `Set<string>` of unique servers in this turn — invocations count one per server per turn even if the turn called the same server multiple times.
- Per-tool call count increments per name (each individual `tool_use` block).
- Compute the turn's dollar cost via `getPricing(model)` + `toDollars()` for input/output/cacheCreate/cacheRead.
- Attribute the **full turn cost and full token total** to each unique server in the set (matches the loaded-cost model).
- Track per-server: `invocations`, `lastInvoked` (max ts), `tokens`, `dollars`, and a `Map<toolName, {calls, lastInvoked}>`.
- Return sorted by `dollars desc`. Per-tool sub-array sorted by `calls desc`.

**`computeMCPRelationships(since?: Date): MCPRelationship[]`**

For each emitted assistant turn where `currentSkill !== null`:
- For each unique server in the turn, increment `(currentSkill, serverName).calls`.

Return one entry per `(skill, server)` pair, sorted by `calls desc`.

### A2. Routes in `server/src/index.ts`

Add immediately after the existing MCP block (around line 543):

```typescript
app.get('/api/mcp/usage', (req, res) => {
  try {
    const tf = parseTimeframe(req.query.timeframe)
    const since = sinceDate(tf) ?? undefined
    const summaries = computeMCPUsage(since)
    res.json({ summaries })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.get('/api/mcp/relationships', (_req, res) => {
  try {
    const relationships = computeMCPRelationships()
    res.json({ relationships })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})
```

### A3. Tests

- Add a small JSONL fixture (mirror whatever pattern `usage/attributor` tests already use — check `server/src/usage/__tests__` or wherever tests live).
- Cover: per-turn deduping, multi-server turns, skill→server attribution, `since` filter, unknown-skill resets `currentSkill`.

### A4. Sanity-check via curl before moving on

```bash
curl -s localhost:<port>/api/mcp/usage?timeframe=week | jq '.summaries[0]'
curl -s localhost:<port>/api/mcp/relationships | jq '.relationships[0:3]'
```

---

## Phase B — Frontend wiring

### B1. `client/src/api.ts`

Add the matching types and fetchers:

```typescript
export interface MCPToolUsage { name: string; calls: number; lastInvoked: string }
export interface MCPUsageSummary {
  serverName: string
  invocations: number
  lastInvoked: string
  tokens: number
  dollars: number
  tools: MCPToolUsage[]
}
export interface MCPRelationship { skillName: string; serverName: string; calls: number }

export async function fetchMCPUsage(timeframe?: Timeframe): Promise<MCPUsageSummary[]> {
  const qs = timeframe && timeframe !== 'all' ? `?timeframe=${timeframe}` : ''
  const res = await fetch(`/api/mcp/usage${qs}`)
  return (await parseResponse<{ summaries: MCPUsageSummary[] }>(res)).summaries
}

export async function fetchMCPRelationships(): Promise<MCPRelationship[]> {
  const res = await fetch('/api/mcp/relationships')
  return (await parseResponse<{ relationships: MCPRelationship[] }>(res)).relationships
}
```

### B2. `client/src/App.tsx`

- Add `fetchMCPUsage(timeframe)` and `fetchMCPRelationships()` to the existing `Promise.all` in `load()`.
- Build `Map<serverName, MCPUsageSummary>` from the result.
- Change `toMCPSkill(entry: MCPRow)` to `toMCPSkill(entry: MCPRow, usage?: MCPUsageSummary): Skill`. When `usage` is present:
  - `activeDollars = usage.dollars`
  - `totalDollars = usage.dollars`
  - `lastInvoked = usage.lastInvoked`
  - `dormant` computed against the same `DORMANT_DAYS` threshold used for regular skills
  - Loaded fields stay zero (MCPs have no "loaded" concept).
- Hold `mcpUsageMap` and `mcpRelationships` in state. Refetch usage when `timeframe` changes (same trigger that drives `fetchUsageAggregate`).
- Pass `mcpUsageMap` and `mcpRelationships` as new props to `<DetailDrawer>`.

**Do not** embed `MCPUsageSummary` inside the `Skill` type — pass it through a separate prop to keep main skill state lean.

### B3. `client/src/components/InventoryTable.tsx`

Locate the MCP-row branch that hardcodes `"—"` for the dollar columns:

- If `skill.totalDollars > 0`, render using the same `dollar-link` / formatting helper used by regular skill rows. Reuse the existing helper — do not duplicate.
- Modified column: format `lastInvoked` if non-empty (use whatever date helper regular rows use), else `"—"`.
- Enabled column: stays `"—"` for all MCP rows.

### B4. `client/src/components/DetailDrawer.tsx`

Add new props:
```typescript
mcpUsageMap?: Map<string, MCPUsageSummary>
mcpRelationships?: MCPRelationship[]
```

Inside the `isMCP` branch, after the existing tools table:

**a) Usage section** — only if `mcpUsageMap.get(serverName)` exists:
- Header row: total invocations, total dollars, last invoked.
- Per-tool table: `tool name | calls | last invoked`, sorted by `calls desc`.

**b) Called by section** — only if `mcpRelationships` has entries with `serverName === this.serverName`:
- List of clickable buttons, sorted by `calls desc`.
- Resolve each `skillName` to a `Skill` object via the existing `allSkills` prop.
- On click: `onSelect(skill)`. Mirror the existing inbound-link pattern in `RelationshipMap`.

---

## Phase C — Verify

1. `npm test` — must stay at 112 passing (plus the new ones added in A3).
2. `node_modules/.bin/tsc -p client/tsconfig.json --noEmit`
3. `node_modules/.bin/tsc -p tsconfig.server.json --noEmit` (or whichever server tsconfig exists) — for the new server file.
4. Curl both new endpoints; eyeball the numbers against a session you remember.
5. `npm run dev`, find a server with usage in the inventory table, confirm:
   - Cost columns and Modified column populate.
   - Drawer shows Usage section with per-tool breakdown.
   - Drawer shows Called by section; clicking a skill button switches the drawer to that skill.

---

## Constraints

- No new npm dependencies.
- Do not break the 112 existing tests.
- TypeScript strict — both client and server tsc passes must be clean.
- Reuse `MCP_RE`; do not redefine the regex.
- Reuse existing dollar/date formatting helpers in the table; do not duplicate.

## Risk notes

- **Per-turn deduping**: turns that call the same server multiple times must count as one invocation. Use a `Set<serverName>` per turn before incrementing counters.
- **`currentSkill` reset**: copy attributor's exact behavior — unknown `<command-name>` values reset to `null` so relationships don't leak across skill boundaries.
- **Single file walk**: doing usage + relationships in one pass costs ~half the I/O. Worth the small `walkMCPSessions` refactor.
- **`MCPUsageSummary` placement**: keep it out of the `Skill` type; pass via prop to `DetailDrawer` to avoid inflating main skill state.

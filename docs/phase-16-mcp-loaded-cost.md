# Phase 16 — MCP loaded cost

Apply the loaded-cost model to MCP servers. Today MCP rows show `—` for loaded dollars; this phase fills that column using each server's tool schemas as the loaded weight.

## Background

MCP tool schemas are sent with every API call as part of the tool definitions. That's a passive context tax — same shape as the skill listing problem, different content. The existing `loaded.ts` model maps directly:

| Skill loaded cost | MCP loaded cost |
|---|---|
| listing bytes (name + description) | `schemaBytes` (sum of tool schema JSON sizes) |
| 8000-byte listing budget | none — tool schemas are uncapped |
| `BYTES_PER_TOKEN = 4` | tokenizer (Phase 15) |
| Per-session cache state | same — tool defs are part of cached prefix |

This phase should land **after Phase 15** so it inherits the tokenizer + cache-state fixes from the start.

## Files to read first

```
server/src/mcp/inventory.ts        — schemaBytes per server
server/src/mcp/types.ts            — MCPServerEntry shape
server/src/mcp/usage.ts            — existing MCP active cost
server/src/usage/loaded.ts         — model to mirror (post Phase 15)
client/src/App.tsx                 — toMCPSkill — currently zeros loadedDollars
client/src/components/InventoryTable.tsx — MCP row loaded column hardcodes —
docs/cost-calculations.md          — accuracy framework
```

---

## Phase A — Backend: `computeMCPLoadedCost`

### A1. Add to `server/src/mcp/usage.ts`

New public function alongside `computeMCPUsage` and `computeMCPRelationships`:

```typescript
export interface MCPLoadedCostEntry {
  serverName: string
  schemaBytes: number       // raw input
  schemaTokens: number      // tokenized
  loadedTurns: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalDollars: number
}

export function computeMCPLoadedCost(since?: Date): MCPLoadedCostEntry[]
```

### A2. Algorithm

Mirror `loaded.ts → processSession()` exactly, but with these substitutions:

1. **Source of weights:** call `buildMCPInventory()` to get configured servers. Filter:
   - Skip `kind === 'session-injected'` (no schema available).
   - Skip `schemaBytes === null` (probe failed or not applicable).
   - Skip `status !== 'ok'` (server unavailable means tools weren't actually loaded).
2. **Prepare each server:**
   - Stringify each tool's full schema object (the same JSON that gets sent to the API), tokenize via `@anthropic-ai/tokenizer.countTokens()`. Sum across the server's tools → `schemaTokens`.
   - **Don't** re-derive tokens from `schemaBytes / 4` — go through the tokenizer, since JSON tokenizes denser than prose (~4.6 bytes/token empirically) and the existing `schemaBytes` is byte-exact JSON.
3. **No budget cap.** Tool definitions are uncapped in the API request.
4. **Per-session cache state** (same as Phase 15): first qualifying turn → `cacheWritePerM`, subsequent in same `sessionId` → `cacheReadPerM`.
5. **One walk, share with existing functions.** Refactor `walkMCPSessions` to also emit a "every assistant turn" callback (not just turns with MCP tool uses), since loaded cost applies to every turn regardless of whether MCP was called. Or accept an extra walk — the I/O is small enough that "correctness over cleverness" wins here. **Recommend:** add a parallel walker that doesn't filter by mcpToolNames.

### A3. Tool schema source

The MCP probe stores tool schemas in the cache (`server/src/mcp/cache.ts`). Verify the cached schema JSON is the same shape that gets sent to the model — if Claude Code wraps or reformats it, our token count will diverge. Spot-check by comparing a cached schema against what the Anthropic SDK serializes when you pass the same tool through `messages.create({ tools: […] })`.

If they diverge, document the divergence in the entry comment and accept it as a known approximation (probably <5%).

### A4. Route

In `server/src/index.ts`, add:

```typescript
app.get('/api/mcp/loaded', (req, res) => {
  try {
    const tf = parseTimeframe(req.query.timeframe)
    const since = sinceDate(tf) ?? undefined
    res.json({ entries: computeMCPLoadedCost(since) })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})
```

### A5. Tests

Add to `server/src/__tests__/mcp-usage.test.ts` (or a new `mcp-loaded.test.ts`):

- One server with 1 tool, 1 session with 3 assistant turns → expect 1 cache_create + 2 cache_read accumulations.
- Two servers, multi-session — verify per-session first-turn detection is correct per server.
- `kind: session-injected` is excluded.
- `status: 'unavailable'` is excluded.
- `since` filter cuts pre-window turns.

---

## Phase B — Frontend wiring

### B1. `client/src/api.ts`

```typescript
export interface MCPLoadedCostEntry {
  serverName: string
  schemaBytes: number
  schemaTokens: number
  loadedTurns: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalDollars: number
}

export async function fetchMCPLoaded(timeframe?: Timeframe): Promise<MCPLoadedCostEntry[]> {
  const qs = timeframe && timeframe !== 'all' ? `?timeframe=${timeframe}` : ''
  const res = await fetch(`/api/mcp/loaded${qs}`)
  return (await parseResponse<{ entries: MCPLoadedCostEntry[] }>(res)).entries
}
```

### B2. `client/src/App.tsx`

- Add `fetchMCPLoaded(timeframe)` to the existing `Promise.all` in `load()`.
- Build `Map<serverName, MCPLoadedCostEntry>` from the result.
- Update `toMCPSkill(entry, usage?, loaded?)` to set:
  - `loadedDollars = loaded?.totalDollars ?? 0`
  - `totalDollars = (usage?.dollars ?? 0) + (loaded?.totalDollars ?? 0)` (was just usage)
- Pass `mcpLoadedMap` as a prop to `DetailDrawer`.

### B3. `client/src/components/InventoryTable.tsx`

Update the MCP row's loaded column. Currently hardcodes `—`:

```tsx
<td className="col-loadedDollars col-numeric">
  {isMCP ? (
    skill.loadedDollars > 0
      ? <span className="dollar-link" onClick={e => e.stopPropagation()} title="MCP loaded cost (tool schemas)">{fmtDollars(skill.loadedDollars)}</span>
      : <span className="col-mcp-dash">—</span>
  ) : (/* existing skill branch */)}
</td>
```

### B4. `client/src/components/DetailDrawer.tsx`

Add to the MCP branch's Usage section, alongside active stats:

- Loaded section: `schemaTokens`, `loadedTurns`, `loaded dollars`.
- Tooltip / footnote: "Loaded cost = passive cost of including this server's tool schemas in every API call's tool definitions. Excludes session-injected servers (no schema)."

---

## Phase C — Verify

1. `npm test` — green.
2. Both `tsc --noEmit` passes — clean (excluding pre-existing `stdioClient.ts` errors).
3. Curl: `curl -s localhost:3001/api/mcp/loaded?timeframe=week | jq '.entries[0]'` — verify the top server has plausible numbers.
4. UI check: open an MCP server in the drawer, confirm Loaded section shows numbers and the inventory row's Loaded column populates.
5. Sanity ratio: a server with N tools and M assistant turns since `since` should have `loadedTurns ≈ M` (every turn loads its schemas) and `cacheReadTokens ≈ schemaTokens × (M - sessionsTouched)`.

## Constraints

- Depends on Phase 15 (tokenizer infrastructure must exist).
- No new dependencies beyond what Phase 15 added.
- Don't double-count: MCP active cost (existing) and MCP loaded cost (new) are independent. Don't subtract one from the other.
- Session-injected servers continue to show `—` for loaded — this is correct (no schema = no measurable contribution).

## Risk notes

- **Schema serialization drift.** If Claude Code transforms tool schemas before sending (adds wrappers, normalizes types), our cached-schema token count will be off. Acceptable approximation; document if observed.
- **"Always loaded" assumption.** We assume tool schemas are in every assistant turn. True for healthy configured servers; not true if the server crashed or wasn't reachable for that turn. We have no per-turn signal of server health.
- **Multi-server budget interaction.** Unlike skill listings, tool definitions don't share a budget cap. Each server's loaded cost is independent. No `effectiveScale` needed.

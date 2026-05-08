# Phase 19 — Tool output bloat tracking

Measure how many tokens each skill's tool calls dump back into the context as `tool_result` blocks. Tools like `Bash`, `Read` (large files), `WebFetch`, `Grep` (broad scans) can return tens of thousands of tokens that become input on every subsequent turn until compaction. This is the most actionable cost signal nobody is measuring.

## Background

When a tool returns its result, the result content is appended to the conversation as a `user` turn with content type `tool_result`. From that point on, every subsequent assistant turn pays input/cache tokens for that result. A 50 KB Bash output silently inflates every following turn by ~12k tokens.

Currently invisible because:
- Active cost measures input tokens but doesn't decompose them by source.
- Tool results aren't tied back to which `tool_use` generated them in our pipeline (they are in the JSONL, via `tool_use_id`).

## Files to read first

```
server/src/usage/parser.ts          — extractToolUses (tool_use side); tool_result side not yet handled
server/src/usage/attributor.ts      — current active-cost state machine
server/src/mcp/sessionInjected.ts   — example of scanning content arrays
docs/cost-calculations.md           — pipeline reference
```

---

## Phase A — Backend: tool result measurement

### A1. JSONL structure recap

A `user` turn following a `tool_use` looks like:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_abc123",
        "content": "...the result text..."  // or an array of blocks
      }
    ]
  }
}
```

`content` can be a string or an array of `{type: 'text', text: '…'}` / `{type: 'image', source: …}` blocks. Handle both.

### A2. New file: `server/src/usage/toolResults.ts`

```typescript
export interface ToolResultEntry {
  toolName: string         // resolved from the matching tool_use by id
  skillName: string        // currentSkill at the time of the originating tool_use
  invocations: number      // how many tool_use calls of this name under this skill
  totalBytes: number       // sum of result content bytes
  totalTokens: number      // tokenized via @anthropic-ai/tokenizer
  // Estimated downstream cost: tokens × turns_remaining_in_session × cache_read_rate
  estimatedDownstreamDollars: number
}

export function computeToolResultBloat(since?: Date): ToolResultEntry[]
```

### A3. Algorithm

Walk session JSONLs. Maintain:
- `currentSkill: string | null` (same as attributor)
- `pendingToolUses: Map<tool_use_id, { name: string; skill: string | null; turnIndex: number }>`
- `turnIndex: number` (counts assistant turns within session, for the downstream-cost estimate)

For each line:
1. **User turn with tool_result blocks:** For each `tool_result` block:
   - Look up `tool_use_id` in `pendingToolUses` to recover `(toolName, skillName)`.
   - Measure result content bytes (stringify content if array, sum text).
   - Tokenize via `@anthropic-ai/tokenizer.countTokens()`.
   - Compute downstream cost estimate (see A4 below).
   - Accumulate into per-(skill, tool) buckets.
   - Remove from `pendingToolUses`.
2. **Assistant turn with tool_use blocks:** record each in `pendingToolUses`. Increment `turnIndex`.
3. **User turn with `<command-name>`:** update `currentSkill`.

### A4. Downstream cost estimate

The actual cost of a bloated tool result is hard to attribute exactly because:
- It increases input tokens on every following turn until that prefix is compacted.
- Cache treatment depends on whether subsequent turns hit the cache.

Use a conservative estimate:
```
estimatedDownstreamDollars =
  resultTokens × remainingTurnsInSession × cacheReadPerM[modeOfModel] / 1e6
```

Where `remainingTurnsInSession` = total turns after this tool_use within the same session (cap at, say, 50 to avoid one bloated result dominating long sessions).

This is an estimate, not exact — clearly label as such in the UI. The relative ranking between tools/skills is the actionable signal; absolute dollars are illustrative.

### A5. Route

```typescript
app.get('/api/usage/tool-bloat', (req, res) => {
  try {
    const tf = parseTimeframe(req.query.timeframe)
    const since = sinceDate(tf) ?? undefined
    res.json({ entries: computeToolResultBloat(since) })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})
```

### A6. Tests

`server/src/__tests__/tool-bloat.test.ts`:

- `Bash` tool returns 100 KB string → entry has `totalBytes ≈ 100_000`, tokens > 0.
- Tool result with array content (`[{type:'text',text:'a'},{type:'text',text:'b'}]`) → bytes summed correctly.
- Tool result for tool_use with no preceding skill → `skillName === '<unattributed>'`.
- `since` filter excludes pre-window tool_uses (filter on the originating tool_use's timestamp, not the result's).
- Image tool_result blocks → counted in bytes/tokens? Anthropic bills images differently; for Phase 19 either skip image blocks or estimate at a fixed token cost (1568 per image per Anthropic docs). Pick **skip with a logged warning**; image-cost tracking is a separate phase.

---

## Phase B — Frontend

### B1. `client/src/api.ts`

```typescript
export interface ToolBloatEntry {
  toolName: string
  skillName: string
  invocations: number
  totalBytes: number
  totalTokens: number
  estimatedDownstreamDollars: number
}

export async function fetchToolBloat(timeframe?: Timeframe): Promise<ToolBloatEntry[]>
```

### B2. Detail drawer addition

In `DetailDrawer.tsx`, for non-MCP skills, add a "Tool output footprint" accordion section:

- List of (tool, totalTokens, estimatedDownstreamDollars) for this skill, sorted by tokens desc.
- Top entry highlighted if estimatedDownstreamDollars > $0.10 (configurable threshold).
- Tooltip: "Estimated downstream cost from this tool's outputs sitting in context. Approximate."

### B3. Inventory hint

Don't add a column. Add a small icon (📦 or similar) next to skills where `estimatedDownstreamDollars > $1` over the active timeframe, with a tooltip explaining "high tool-output footprint." Click → opens the drawer to that section.

### B4. Optional: top-bloat banner

If total estimated bloat dollars > 10% of total spend, surface a banner: "⚠ Tool output bloat estimated at $X.XX — top offender: skill foo's Bash usage."

---

## Phase C — Verify

1. `npm test` — green.
2. Both `tsc --noEmit` clean.
3. Curl `localhost:3001/api/usage/tool-bloat | jq '.entries[0:5]'` — top entries should be skills you remember running with verbose Bash/Read calls.
4. Spot-check: pick a skill that runs `Bash ls -la /` (or similar high-output command) — its `Bash` entry should have visible bytes.
5. Compare a "clean" skill (no tool calls) — should have no entries.

## Constraints

- Tokenizer must already be installed (Phase 15 prerequisite).
- Don't double-attribute: tool output bloat is an *estimate* of downstream cost — it's not added to active or loaded cost. It's a separate diagnostic axis.
- Skip image blocks for now; document the gap.

## Risk notes

- **The "downstream cost" estimate is the loosest number in the entire app.** It assumes the tool result stays in context for `remainingTurnsInSession`, which isn't true after compaction. Likely overstates by 2–5×. Communicate uncertainty in the UI; use this for relative comparison, not absolute budgeting.
- **Tool result content size doesn't always equal token cost.** Bash output with lots of repeated whitespace tokenizes more efficiently than dense JSON. The tokenizer call handles this correctly per-result; the overall estimate accuracy is bounded by the downstream-cost assumption above.
- **Cap sessions at 50 follow-up turns** when computing `remainingTurnsInSession` to prevent one bloated result in a 500-turn session from dominating the rankings.
- **Tool result in the parent thread vs subagent.** Sidechain turns have their own context. Don't count subagent tool results as bloating the parent's context. Filter by `isSidechain` if needed.

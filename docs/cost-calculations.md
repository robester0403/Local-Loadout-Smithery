# Cost calculations — reference

How the app computes per-skill cost, what's exact, what's approximate, and by how much.

## Inputs

All cost data comes from Claude Code session logs at `~/.claude*/projects/**/*.jsonl`. Each line is a JSON object representing one event in a conversation. The fields the cost pipeline reads:

- `type` — `'assistant'` | `'user'` | other
- `timestamp` — ISO8601 string
- `sessionId` — conversation UUID (top-level field, not inside `message`)
- `cwd` — working directory at time of turn
- `message.role` — for assistant turns, must be `'assistant'`
- `message.model` — model ID (e.g. `claude-sonnet-4-6`)
- `message.context_management` — non-null on auto-compaction turns
- `message.usage`:
  - `input_tokens` — uncached input tokens (full rate)
  - `output_tokens` — generated tokens
  - `cache_creation_input_tokens` — newly-cached input (1.25× input rate)
  - `cache_read_input_tokens` — cache hits (0.1× input rate)
- `message.content` — for user turns, a string; for assistant turns, an array

For user turns, slash-command invocations include `<command-name>/foo</command-name>` and `<command-message>foo</command-message>` tags in the content string. The skill name comes from `<command-message>`.

## Pricing table

Source: `server/src/usage/pricing.ts`.

```typescript
const DEFAULTS: Record<string, ModelPricing> = {
  'claude-opus-4-7':   { inputPerM: 15.00, outputPerM: 75.00, cacheWritePerM: 18.75, cacheReadPerM: 1.50 },
  'claude-opus-4-6':   { inputPerM: 15.00, outputPerM: 75.00, cacheWritePerM: 18.75, cacheReadPerM: 1.50 },
  'claude-sonnet-4-6': { inputPerM:  3.00, outputPerM: 15.00, cacheWritePerM:  3.75, cacheReadPerM: 0.30 },
  'claude-haiku-4-5':  { inputPerM:  0.80, outputPerM:  4.00, cacheWritePerM:  1.00, cacheReadPerM: 0.08 },
  '<synthetic>':       { inputPerM:  0,    outputPerM:  0,    cacheWritePerM:  0,    cacheReadPerM: 0    },
}
```

Users can override by writing `~/.local-skill-manager/pricing.json`. Model lookup falls back to a longest-prefix match (so `claude-haiku-4-5-20251001` resolves to `claude-haiku-4-5`).

`toDollars(tokens, ratePerM)` is just `(tokens / 1e6) * ratePerM`.

If `getPricing(model)` returns `null` (unknown model), the turn's dollar cost is `0`. This silently understates cost when the table is stale. There's no warning in the current pipeline.

## Active cost

> "Body-token cost while the skill's full body is in the cached system prompt."

### Definition

A skill's body is injected into the cached context on activation and stays there until the session is compacted or ends. Active cost is the cache_write cost on the activation turn plus cache_read cost on every subsequent turn where the body is still present.

This replaces the former slash-command-window model. The new definition is harness-agnostic (works for auto-triggered skills, not just `/skill-name` invocations) and measures the skill's actual marginal cost rather than the total cost of everything that happened while it was active.

### Algorithm

Sources: `server/src/usage/activation.ts` (detection), `server/src/usage/active.ts` (cost roll-up).

**Step 1 — detect activations via cache-creation deltas (activation.ts):**

For each session JSONL, walk assistant turns in timestamp order:

1. On a **compaction turn** (`message.context_management` is non-null): clear the injected-skills set.
2. On a **normal assistant turn**: read `cache_creation_input_tokens` (cc).
   - If `cc > MIN_DELTA_TOLERANCE` (200 tokens): attempt to match against known skills.
   - **Single match:** if exactly one skill has `bodyTokens` within ±15% of `cc`, record an `ActivationEvent` for that skill at this turn index. Add skill to the injected set.
   - **Ambiguous match:** multiple skills within tolerance — use a preceding slash-command hint (`<command-message>`) as tiebreaker if available.
   - **No match / below threshold:** record an unexplained delta; skill is not marked active.
3. Once a skill is in the injected set it is not a candidate for re-activation in the same session (until compaction clears the set).

**Step 2 — attribute costs per session (active.ts):**

Walk each session's assistant turns again, maintaining `activeSet: Set<string>`:

1. **Compaction turn:** `activeSet.clear()`.
2. **Normal assistant turn at `turnIndex`:**
   - `newlyActivated = byTurn.get(turnIndex) ?? []` (from Step 1 results).
   - For each **newly activated** skill: `activations++`, `cacheCreationTokens += bodyTokens`, charge `toDollars(bodyTokens, cacheWritePerM)`.
   - For each skill **already in `activeSet`** (not newly activated): `cacheReadTokens += bodyTokens`, charge `toDollars(bodyTokens, cacheReadPerM)`.
3. Return entries sorted by `totalDollars` descending.

### Accuracy

**Exact** when a skill's body size is unambiguously distinguishable from other skills.

**Known sources of inaccuracy:**

- **Ambiguous body sizes.** Two or more skills with `bodyTokens` within 15% of each other may confuse the matcher. The slash-command hint resolves most cases; ambiguous cases go unmatched (`unexplainedDelta`).
- **Undetectable activations.** If a skill is injected without a `cache_creation_input_tokens` delta (e.g., served fully from cache after a cold restart), no activation event fires and the skill is invisible to active cost.
- **Unknown bodyTokens.** Skills must have `bodyTokens > 0` to be candidates. Skills without a measured body contribute nothing to active cost.
- **Stale pricing table / unknown models** — same as for loaded cost.
- **Subagent sidechain turns.** Turns from spawned `Task` agents have no activation signal in the parent session. Phase 17 addresses this.

## Loaded cost

> "Passive listing tax — tokens the skill contributes to every turn just by being installed."

### Definition

Claude Code injects every available skill's name and description into the system prompt on every API call (the "skill listing"). Even if the skill is never invoked, you pay for those tokens on every turn. Loaded cost attributes this passive overhead per skill.

Per Claude Code docs:
- Each skill's description is truncated at **1536 bytes**.
- The total listing budget is **8000 bytes** (1% of context window, fallback to 8000).
- Skill names are always included in full.
- **Commands are excluded** from the listing — they're only injected on-demand when `/cmd` is typed.

### Algorithm

Source: `server/src/usage/loaded.ts`.

**Step 1 — compute each skill's listing contribution:**

```typescript
listingBytesFor(name, description) =
  utf8Bytes(name) + 1 + min(utf8Bytes(description), 1536)

listingTokensFor(name, description) =
  countTokens(`${name} ${description.slice(0, 1536)}`.trimEnd())
```

`countTokens` uses `@anthropic-ai/tokenizer` locally — no network call.

**Step 2 — apply the budget cap:**

```typescript
rawTotalBytes = sum(listingBytesFor(s) for non-command skills)
effectiveScale = min(1, 8000 / rawTotalBytes)
effectiveTokens = listingTokens × effectiveScale
```

Scale is computed in bytes (to mirror Claude Code's byte-based budget) but applied to the token count. If the total listing fits in 8000 bytes, `effectiveScale = 1` (no cap).

**Step 3 — for each assistant turn, attribute cost using per-session cache state:**

```typescript
// Skip turns with no input-side activity
if (input_tokens + cache_creation_input_tokens + cache_read_input_tokens === 0) continue

// First qualifying turn of a session → listing enters cache (cache_write rate)
// All subsequent turns in the same session → cache hit (cache_read rate)
isFirstTurn = !seenSessionIds.has(sessionId)
if (sessionId) seenSessionIds.add(sessionId)

dollars = isFirstTurn
  ? toDollars(effectiveTokens, cacheWritePerM)
  : toDollars(effectiveTokens, cacheReadPerM)
```

**Step 4** — accumulate `cacheCreationTokens`, `cacheReadTokens`, `totalDollars` per skill across all turns; return sorted by `totalDollars` descending.

### Accuracy

Substantially more accurate than the prior model. Two remaining sources of imprecision:

#### Source 1 — tokenizer era mismatch

`@anthropic-ai/tokenizer` implements the Claude 1/2 BPE table. Claude 3/4 models (including Sonnet 4.6) use a different tokenizer. The difference is typically 2–5% for English prose. The prior `bytes / 4` approximation was off by ~18% in the same direction (overcount); the current implementation is an improvement in magnitude but may still overcount slightly for complex skill descriptions.

#### Source 2 — cache state model simplification

The pipeline assumes the listing is always present and always follows the first-turn / subsequent-turn split by `sessionId`. In reality:

- The listing may be absent if the session starts from a compacted context (cold cache). We model it as present, which overstates cost for those sessions.
- Sessions without a `sessionId` field in their JSONL (older Claude Code versions) treat every turn as a first turn, overstating cache_write cost.

Net effect: ~5–10% overcount on loaded dollars, direction is upward.

#### What loaded cost cannot capture

- **Whether the skill was actually injected.** Claude Code may skip the listing in some contexts. We assume it's always present.
- **Other system prompt content.** Tool definitions, project-specific instructions, base prompt — all of these also live in the cached prefix.
- **MCP tool schema cost.** Tracked separately (Phase 16).
- **Compaction overhead.** Auto-compaction rewrites context with its own LLM call; not surfaced.

### Quantified accuracy summary

| Component | Error source | Magnitude | Direction | Status |
|---|---|---|---|---|
| Active cost — detection | Ambiguous body sizes | small (skill-dependent) | miss | Partial fix via slash-command hint |
| Active cost — detection | No cc delta on inject | unknown | miss | Known gap |
| Active cost — dollars | Stale pricing table | unknown | varies | Manual update required |
| Active cost — dollars | Unknown model → $0 | 100% under | always under | Update pricing table |
| Active cost — dollars | Subagent turns | unknown | usually under | Phase 17 |
| Loaded tokens | Tokenizer era (BPE) | ~2–5% over | usually over | Best available without network |
| Loaded dollars | Sessions without sessionId | small | over | Older Claude Code sessions |
| Loaded dollars | Cache-absent sessions | small | over | Cannot detect from logs |

## Aggregation

Source: `server/src/usage/aggregate.ts`.

`computeSkillAggregate(skills?, since?)`:
1. Calls `computeActiveCost()` and `computeLoadedCost()` independently.
2. Merges by `skillName` into a unified `SkillCostSummary` per skill:
   - `active: { tokens: cacheCreationTokens + cacheReadTokens, dollars }`
   - `loaded: { tokens: cacheCreationTokens + cacheReadTokens, dollars }`
   - `total: { tokens: active + loaded, dollars: active + loaded }`
3. Returns sorted by `total.dollars` descending.

Active and loaded are independent computations over the same JSONL — neither depends on the other.

## Timeframe filter

Source: `server/src/usage/timeframe.ts`.

- `parseTimeframe(raw)` → one of `'day' | 'week' | 'month' | 'quarter' | 'year' | 'all'`
- `sinceDate(tf)` → `Date | null`. `null` for `'all'`, otherwise `now - N days` (24h / 7d / 30d / 90d / 365d).

The `since` parameter is applied to **assistant-turn timestamps only**. Sessions that started before `since` but had qualifying turns after are still processed correctly: the active engine pre-loads state from before-`since` turns (so skills already in context at `since` are correctly tracked) without charging them to the filtered period.

## Out-of-scope today (tracked elsewhere)

- **MCP usage cost.** Tracked in `server/src/mcp/usage.ts` as a separate axis (per-MCP-server invocations + dollars). Documented in `docs/phase-14-mcp-usage.md`.
- **MCP loaded cost.** Not yet implemented. See `docs/phase-16-mcp-loaded-cost.md`.
- **Subagent / Task cost.** Currently mis-attributed or invisible. See `docs/phase-17-subagent-and-waste.md`.
- **Failed-turn waste.** Currently billed silently. See `docs/phase-17-subagent-and-waste.md`.
- **Compaction overhead.** Not extracted. Tracked as future work.
- **Tool-result token bloat.** Not extracted. See `docs/phase-19-tool-output-bloat.md`.
- **Per-session, per-project, per-branch rollups.** Not surfaced. See `docs/phase-18-session-view.md` and `docs/phase-20-operational-rollups.md`.

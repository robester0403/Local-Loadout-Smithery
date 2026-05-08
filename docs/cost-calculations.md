# Cost calculations — reference

How the app computes per-skill cost, what's exact, what's approximate, and by how much.

## Inputs

All cost data comes from Claude Code session logs at `~/.claude*/projects/**/*.jsonl`. Each line is a JSON object representing one event in a conversation. The fields the cost pipeline reads:

- `type` — `'assistant'` | `'user'` | other
- `timestamp` — ISO8601 string
- `sessionId` — conversation UUID
- `cwd` — working directory at time of turn
- `message.role` — for assistant turns, must be `'assistant'`
- `message.model` — model ID (e.g. `claude-sonnet-4-6`)
- `message.usage`:
  - `input_tokens` — uncached input tokens (full rate)
  - `output_tokens` — generated tokens
  - `cache_creation_input_tokens` — newly-cached input (1.25× input rate)
  - `cache_read_input_tokens` — cache hits (0.1× input rate)
- `message.content` — for user turns, a string; for assistant turns, an array that may include `{type: 'tool_use', name: '…'}` blocks

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

> "Tokens spent while a skill was the active context."

### Definition

A skill is "active" from the moment its slash command appears in a user turn until the next slash command (which may be a different skill, a built-in, or no command at all). Active cost is the sum of all assistant-turn costs incurred during that window.

### Algorithm

Source: `server/src/usage/attributor.ts → parseSessionActiveCost()`.

For each session JSONL, walk lines in order, maintaining a `currentSkill: string | null` state machine:

1. **User turn with `<command-name>` tag:**
   - Extract the skill name from `<command-message>`.
   - If `validSkills.has(name)`: set `currentSkill = name`, mark `newInvocation = true`.
   - Else (built-in like `/model`, or unknown): set `currentSkill = null`. **All subsequent assistant turns are unattributed until another known skill command appears.**

2. **Assistant turn:**
   - Skip if `currentSkill === null` (no attribution target).
   - Skip if `since` filter is set and `timestamp < since`.
   - Compute dollar cost from `usage` and `model` via `getPricing()` + `toDollars()` for input, output, cache_creation, cache_read.
   - Add tokens and dollars to the accumulator for `currentSkill`.
   - If `newInvocation` was true, increment `invocations` and clear the flag.

3. Return entries sorted by `totalDollars` descending.

### Accuracy

**Exact** for everything the algorithm captures. No estimation, no approximation. Token counts come straight from `message.usage` and dollars come from a deterministic price table.

**Caveats — known sources of inaccuracy:**

- **Stale pricing table.** If a model's listed price diverges from current Anthropic pricing, cost is wrong by that delta. Silent failure mode.
- **Unknown models price at $0.** Future model IDs without a prefix match in the pricing table contribute zero dollars.
- **Subagent (sidechain) turns are mis-attributed.** When a skill spawns a `Task` subagent, those turns appear with `isSidechain: true` and have no `<command-name>` triggering them. They're either invisible (no `currentSkill` active) or wrongly billed to whatever skill happened to be active in the parent thread. Phase 17 addresses this.
- **Built-in commands reset `currentSkill` to null.** This is by design — we don't attribute model-switch overhead to the previous skill — but it means turns immediately after a built-in are unattributed even if they were doing the previous skill's work.
- **Failed turns are billed.** Turns with `apiErrorStatus` set still pay for input tokens consumed before the error. They're attributed normally to whatever skill was active. Phase 17 surfaces these as a separate "wasted" line item.

Other than these structural items, active cost is the ground truth from the API's own usage report.

## Loaded cost

> "Passive context tax — tokens the skill contributes to every turn just by being installed."

### Definition

Claude Code injects every available skill's name + description into the system prompt on every API call (the "skill listing"). Even if the skill is never invoked, you pay for those tokens on every turn. Loaded cost attributes this passive overhead per skill.

Per Claude Code docs:
- Each skill's description is truncated at **1536 bytes**.
- The total listing budget is **8000 bytes** (1% of context window, fallback to 8000).
- Skill names are always included in full.
- **Commands are excluded** from the listing — they're only injected on-demand when the user types `/foo`.

### Algorithm

Source: `server/src/usage/loaded.ts`.

**Step 1 — compute each skill's listing contribution in bytes:**

```typescript
listingBytesFor(name, description) =
  utf8Bytes(name) + 1 + min(utf8Bytes(description), 1536)
```

The `+ 1` accounts for the space between name and description.

**Step 2 — apply the budget cap:**

```typescript
rawTotal = sum(listingBytesFor(s) for s in skills if type !== 'command')
effectiveScale = min(1, 8000 / rawTotal)
```

If the total listing exceeds 8000 bytes, every skill's contribution is scaled down proportionally (modeling Claude Code's truncation behavior).

**Step 3 — convert bytes to tokens:**

```typescript
skTokens = (skillBytes * effectiveScale) / 4
```

Constant `BYTES_PER_TOKEN = 4`. **This is the most significant approximation in the pipeline. See accuracy notes below.**

**Step 4 — for each assistant turn, attribute a proportional share of cost:**

```typescript
totalBilled = input + cacheCreate + cacheRead     // excludes output
share = min(skTokens / totalBilled, 1)
skInput       = input        * share
skCacheCreate = cacheCreate  * share
skCacheRead   = cacheRead    * share

dollars = toDollars(skInput,       inputPerM)
        + toDollars(skCacheCreate, cacheWritePerM)
        + toDollars(skCacheRead,   cacheReadPerM)
```

**Step 5** — accumulate per skill across all turns; return sorted by `totalDollars` descending.

### Why proportional attribution

The math simplifies cleanly: the sum of `skInput + skCacheCreate + skCacheRead` equals `skTokens` exactly (the proportions cancel). So **the total token attribution per turn is `skTokens` regardless of `totalBilled`**.

The fraction's only job is to split `skTokens` across the three pricing categories (uncached / cache-write / cache-read) using the same mix as the turn's overall input. That gives a "blended rate" per turn — accurate when the listing's cache state matches the overall input's cache state, approximate otherwise.

### Accuracy

This is the approximate half of the pipeline. Two distinct sources of error:

#### Source 1 — `bytes / 4` tokenization

Empirically measured on the user's actual skill descriptions (15-skill sample, July 2026):

```
3704 bytes → 788 tokens (4.70 bytes/token actual)
bytes/4    → 926 tokens (overestimate by 18%)
```

So loaded cost numbers are **~18% inflated** for typical skill listings. The constant 4 is too low for the kind of text in skill descriptions, which tokenize efficiently due to common English words and BPE merges.

The error direction is consistent (always overcount), so:
- Absolute dollar amounts: overstated by ~10–25% depending on skill content
- Relative ranking between skills: unaffected
- Comparisons over time on the same skill: unaffected

Phase 15 swaps `/ 4` for `@anthropic-ai/tokenizer.countTokens()`, which is local, deterministic, and uses an actual BPE table (Claude 1/2 era — best available without a network call).

#### Source 2 — cache-state mix

The skill listing lives in the cached system prompt. In reality:
- **First turn of a session that hits the prompt:** listing is `cache_creation` (1.25× rate)
- **Subsequent turns in the same session:** listing is `cache_read` (0.1× rate, ~12.5× cheaper than cache_create on Sonnet)
- **Almost never:** listing is uncached `input` tokens

But the proportional formula apportions the listing's tokens across all three categories using the turn's overall mix. On a turn where 80% of input was cache_read (typical mid-conversation), the listing is priced ~80% at cache_read rate. That's close to right — but not exact. On a fresh-cache turn where the entire system prompt is being re-cached, the listing gets priced as `cache_creation`, which is slightly overstated (the listing is one fragment of that cache_create event, not all of it).

Net effect: ~5–10% noise on top of the tokenization error. Direction varies depending on session length distribution.

Phase 15 (optional second part) replaces the proportional mix with an explicit per-session model: first qualifying turn → `cache_creation`, all subsequent turns in that `sessionId` → `cache_read`.

#### What loaded cost cannot capture

Things that fundamentally cannot be extracted from the JSONL:

- **Whether the skill was actually injected.** Claude Code may skip the listing in some contexts. We assume it's always there.
- **Other system prompt content.** Tool definitions, project-specific instructions, base prompt — all of this also lives in the cached prefix. We don't model it because we don't know what's in it.
- **MCP tool schema cost.** Same model would apply (Phase 16) but only for configured servers — session-injected servers have no schema.
- **Compaction overhead.** Auto-compaction rewrites context with its own LLM call. It's billed but not currently surfaced anywhere.

### Quantified accuracy summary

| Component | Error source | Magnitude | Direction | Fix |
|---|---|---|---|---|
| Active dollars | None (within table) | 0% | — | N/A |
| Active dollars | Stale pricing table | unknown | varies | Manual update |
| Active dollars | Unknown model | 100% under | always under | Update table |
| Active dollars | Subagent attribution | unknown | usually under | Phase 17 |
| Loaded tokens | `bytes / 4` | ~18% over | always over | Phase 15 (tokenizer) |
| Loaded dollars | Cache-state mix | ~5–10% noise | varies | Phase 15 (per-session model) |
| Loaded dollars | Other system-prompt content | N/A — out of scope | — | Cannot fix from logs |

## Aggregation

Source: `server/src/usage/aggregate.ts`.

`computeSkillAggregate(skills?, since?)`:
1. Calls `computeActiveCost()` and `computeLoadedCost()` independently.
2. Merges by `skillName` into a unified `SkillCostSummary` per skill:
   - `active: { tokens, dollars }`
   - `loaded: { tokens, dollars }`
   - `total: { tokens: active + loaded, dollars: active + loaded }`
3. Returns sorted by `total.dollars` descending.

Active and loaded are independent computations over the same JSONL — neither depends on the other. They can be reasoned about and improved separately.

## Timeframe filter

Source: `server/src/usage/timeframe.ts`.

- `parseTimeframe(raw)` → one of `'day' | 'week' | 'month' | 'quarter' | 'year' | 'all'`
- `sinceDate(tf)` → `Date | null`. `null` for `'all'`, otherwise `now - N days` (24h / 7d / 30d / 90d / 365d).

The `since` parameter is applied to **assistant-turn timestamps only**. User turns (and the `currentSkill` state machine) are always processed in full so a session that started before `since` but had qualifying turns after still attributes correctly.

## Out-of-scope today (tracked elsewhere)

- **MCP usage cost.** Tracked in `server/src/mcp/usage.ts` as a separate axis (per-MCP-server invocations + dollars). Uses a different attribution model — full turn cost goes to each unique server in the turn. Documented in `docs/phase-14-mcp-usage.md`.
- **MCP loaded cost.** Not yet implemented. See `docs/phase-16-mcp-loaded-cost.md`.
- **Subagent / Task cost.** Currently mis-attributed or invisible. See `docs/phase-17-subagent-and-waste.md`.
- **Failed-turn waste.** Currently billed silently. See `docs/phase-17-subagent-and-waste.md`.
- **Compaction overhead.** Not extracted. Tracked as future work.
- **Tool-result token bloat.** Not extracted. See `docs/phase-19-tool-output-bloat.md`.
- **Per-session, per-project, per-branch rollups.** Not surfaced. See `docs/phase-18-session-view.md` and `docs/phase-20-operational-rollups.md`.

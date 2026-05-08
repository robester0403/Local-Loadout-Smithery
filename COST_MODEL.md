# Cost Model

How `local-skill-manager` calculates per-skill cost from Claude Code session JSONL files.

This is the reference for what every dollar figure in the UI means and where it comes from. If a number looks wrong, this document is the spec — fix the data or fix the spec, but they should agree.

## The two cost axes

Every skill carries two independent costs, accumulated across the timeframe:

| Axis | What it measures | Charged when |
|---|---|---|
| **Active** | Cost of this skill's **body content** sitting in the LLM's cache during turns where it was loaded | The skill body is in the parent session's context |
| **Loaded** | Cost of this skill's **listing entry** (name + description) in the system prompt's skill registry | Every assistant turn — listings are part of the system prompt regardless of whether the skill is invoked |

`Total $ = Active $ + Loaded $`. They never overlap; each token is counted in exactly one axis.

## Pricing tiers

Tokens are priced according to the cache state on the API request that records them. Rates are per million tokens (Sonnet 4.6 shown):

| Tier | Rate | When |
|---|---|---|
| `inputPerM` | $3.00 | Fresh input tokens (uncached) |
| `outputPerM` | $15.00 | Generated assistant tokens |
| `cacheWritePerM` | $3.75 | Tokens being written to cache for the first time |
| `cacheReadPerM` | $0.30 | Tokens being read from existing cache |

The cost model **only uses `cacheWritePerM` and `cacheReadPerM`**. Skill-related content is always cached — it's stable system content. Input/output rates show up in pricing.ts for completeness but are not charged to any skill's Active or Loaded axis.

Pricing source: `server/src/usage/pricing.ts`. Defaults can be overridden by `~/.local-skill-manager/pricing.json`.

## Active cost

The body of a skill (`SKILL.md` content) only enters the parent session's cache when there is a definitive signal that it was injected. The cost model uses **two ground-truth signals** and nothing else:

1. **Slash-command invocation** — a user message contains `<command-message>X</command-message>`. The user typed `/X`.
2. **Skill tool invocation** — an assistant message contains a `tool_use` block with `name: "Skill"` and `input.skill: "Y"`. Claude itself triggered skill Y, including transitive cases where one skill's body instructs Claude to call another.

When either signal fires, the named skill is **queued for activation**. On the next assistant turn:

- If the skill is not already in the active set: charge `bodyTokens × cacheWritePerM` and add to active set.
- On every subsequent assistant turn while the skill remains in the active set: charge `bodyTokens × cacheReadPerM`.
- A compaction turn (assistant message with non-null `context_management`) clears the entire active set. Re-activation requires a fresh signal.

Active cost intentionally excludes **everything else** in the turn's `cache_creation_input_tokens` delta — system prompt, CLAUDE.md, tool registry, file reads, MCP refreshes. Those exist regardless of which skill is loaded and would be misleading if attributed to any skill.

### What is *not* a signal

The earlier version of this model used a `cache_creation_input_tokens` delta matching `bodyTokens` within ±15% as a heuristic to detect auto-triggered activations. **This was retired** because it produced systematic false positives:

- First-turn cache deltas have a median of ~20K tokens (system prompt + listings + CLAUDE.md). Any skill with a body in that range systematically false-matched.
- Post-compaction turns re-cache the full context with the same problem.
- File reads, MCP tool refreshes, and Task tool overhead all create unrelated cache deltas that happened to fall within tolerance of various skill bodies.
- Multiple skills clustering near the same body size were attributed simultaneously to all of them ("attribute to all matches when ambiguous").

The cost of the heuristic was ~$37 of phantom Active $ across ~50 skills the user had never invoked. With signal-based detection, false positives are zero — at the cost of not detecting auto-triggered skills that fire without a slash command or Skill tool call. Those are unmeasurable from the JSONL alone.

### Subagents are excluded

Subagents (`type: 'subagent'`, files under `~/.claude/agents/`) are spawned via the `Agent` tool and run in **a separate context window**. Their bodies are never injected into the parent session's cache, so they cannot accumulate active cost. Subagents are filtered out of the activation candidate pool in both `aggregate.ts` and `breakdown.ts`.

(Subagents still appear in the agent registry portion of the system prompt, which is part of system content, not the skill listing budget. The cost model does not charge them under either axis.)

## Loaded cost

Every non-command skill contributes a "listing entry" to the system prompt: `<name> <description>` with the description capped at 1536 bytes. The total listing is also capped at a global budget.

```
PER_SKILL_DESC_CAP_BYTES = 1536
LISTING_BUDGET_BYTES     = 8000
```

When the un-capped sum of all listing bytes exceeds `LISTING_BUDGET_BYTES`, every skill's contribution scales down proportionally:

```
effectiveScale = min(1, LISTING_BUDGET_BYTES / sum(listingBytes_i for all non-command skills))
skillEffectiveListingTokens = listingTokensFor(name, description) × effectiveScale
```

For each assistant turn that records token usage:

- **First turn of a `sessionId`**: charge `skillEffectiveListingTokens × cacheWritePerM`. Listings entered the cache.
- **Every subsequent turn**: charge `skillEffectiveListingTokens × cacheReadPerM`. Listings are reading from cache.

A turn with `input + cache_create + cache_read = 0` is skipped (no usage, no charge). Compaction turns are not specially handled — they continue the same `sessionId` so they read at cache-read rates (this is a known small mismatch with reality, where compaction probably re-caches; the impact is sub-cent per skill per session).

Commands (`type: 'command'`) are excluded from the listing — they are surfaced via slash-command discovery, not the description registry — so they accumulate no Loaded cost.

Source: `server/src/usage/loaded.ts`.

## How a turn flows through the pipeline

For one assistant turn at index `N` in some session:

1. **Activation events** are computed once across the full history by `detectActivations()` in `activation.ts`. The output is a list of `(sessionId, turnIndex, injectedSkills[])` triples for every turn where a slash-command or Skill-tool signal landed.

2. **`computeActiveCost`** (`active.ts`) walks every session file. For each assistant turn:
   - Look up activation events at this `turnIndex`. Newly-activated skills get `bodyTokens × cacheWritePerM`. Add them to `activeSet`.
   - Every other skill in `activeSet` (carried over from prior turns) gets `bodyTokens × cacheReadPerM`.
   - Compaction turn → `activeSet.clear()`.

3. **`computeLoadedCost`** (`loaded.ts`) walks every session file in parallel. For each assistant turn with non-zero usage, every non-command skill's effective-scaled listing tokens get charged at the appropriate cache tier based on whether its `sessionId` has been seen yet in this file walk.

4. **`computeSkillAggregate`** (`aggregate.ts`) merges the two outputs into one row per skill with `active`, `loaded`, and `total` axes. The Inventory table reads this directly.

5. **`breakdownForSkill`** (`breakdown.ts`) re-runs the same activation detection and turn walk, but for one skill, producing per-turn rows for the modal. It reuses `loaded.ts`'s arithmetic for parity. Loaded turns are aggregated to **one synthetic row per session** (uniform per-turn dollars carry no per-turn information), while Active turns are emitted individually.

The Inventory totals and the Modal subtotals are computed from the same primitives, so they match exactly:

```
Inventory.activeDollars  ==  sum of breakdown rows where attribution == 'active'
Inventory.loadedDollars  ==  sum of breakdown rows where attribution == 'loaded'
Inventory.totalDollars   ==  Modal footer Total
```

## Edge cases worth knowing

- **`since` filter** is applied differently for the two axes. Active state must propagate across the boundary (a skill activated before `since` is still in context after), so pre-`since` turns update `activeSet` without emitting cost. Loaded simply skips pre-`since` turns entirely. This is intentional and matches what each axis is measuring.
- **Pricing fallback** on unknown models: if `getPricing(model)` returns null, dollar amounts for that turn are zero but token counts still accumulate. The model field in the JSONL is matched first exactly, then by prefix, then nothing.
- **Empty `sessionId` lines** in the JSONL receive a quirky first-turn-tracking behavior in `loaded.ts` (every empty-sessionId turn is treated as "first"). In practice every modern Claude Code line has a `sessionId` so this is dormant.
- **Listing tokenization** uses the same tokenizer as body counting (`server/src/usage/tokenizer.ts`). Counts are deterministic for a given input.

## Comparison to reference projects

Two repos provided the original inspiration. Both make different design choices:

- **`oh-my-hi`** (`scripts/parsers/usage.mjs`): tracks which skill was active at each turn, then attributes the **full turn's input + output + cache tokens** to that skill. Records cache-tier counts but does not multiply by tier rates. Has no Loaded axis. Includes subagents.
- **`skills-janitor`** (`scripts/tokencost.sh`): not a per-session cost analyzer. Counts words across all SKILL.md files at a flat 1.3× ratio to estimate static context-window usage if every skill were listed. Used for cleanup recommendations, not historical attribution.

`local-skill-manager` is more granular than either: body-only at cache-tier rates for Active, listing-share at cache-tier rates for Loaded, subagents excluded, signal-based activation. The trade-off is a more complex spec; this document exists to keep it intelligible.

## File map

| Concern | File | Key export |
|---|---|---|
| Activation detection (signals) | `server/src/usage/activation.ts` | `detectActivations`, `ClaudeCodeActivationDetector` |
| Active cost computation | `server/src/usage/active.ts` | `computeActiveCost` |
| Loaded cost computation | `server/src/usage/loaded.ts` | `computeLoadedCost`, `LISTING_BUDGET_BYTES`, `PER_SKILL_DESC_CAP_BYTES` |
| Inventory aggregation | `server/src/usage/aggregate.ts` | `computeSkillAggregate` |
| Per-skill breakdown | `server/src/usage/breakdown.ts` | `breakdownForSkill` |
| Pricing tables | `server/src/usage/pricing.ts` | `getPricing`, `toDollars` |
| API endpoints | `server/src/index.ts` | `/api/usage/aggregate`, `/api/usage/breakdown/:skillId` |
| Inventory UI | `client/src/components/InventoryTable.tsx` | columns: Active $, Loaded $, Total $ |
| Modal UI | `client/src/components/CostBreakdownPanel.tsx` | per-session table + Active / Loaded / Total footer |

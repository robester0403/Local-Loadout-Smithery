# Phase 15 — Universal activation detection

Replace the current "active cost = cost during slash-command window" model with a principled "active cost = body's proportional cost while in context" model. Detect activations via cache-creation token deltas instead of `<command-name>` markers. Result: active cost is correct for both slash-invoked AND auto-triggered skills, and the same algorithm extends cleanly to Cursor in a later phase.

This supersedes the previous Phase 15 (`docs/phase-15-token-accuracy.md`) and folds the tokenizer fix into a larger redesign.

---

## Why this redesign

Two structural problems with the current Claude Code implementation:

**Problem 1: Auto-triggered skills are invisible.**
Today's `attributor.ts` tracks `currentSkill` only when a `<command-name>` tag appears in a user turn. When Claude auto-triggers a skill based on description matching, no tag fires — the skill body is silently injected into the cached system prompt and you pay for it on every subsequent turn, but the cost is attributed to whatever skill happened to have the most recent slash command (or to nothing at all).

**Problem 2: "Active cost" is conceptually muddy.**
Current active cost = the sum of *every dollar* of every turn during a slash-command window (input + output + cache_read + cache_create). But most of those tokens are conversation history, tool results, system prompt — none of which is the skill's "fault." The skill's actual marginal cost is its body bytes × turns it sits in context. The current number conflates "skill responsibility" with "skill window."

**The fix: redefine active as body-tax, detect activations via cache deltas.**

```
loadedDollars = listingTokens × allTurnsInTimeframe × rate
activeDollars = bodyTokens     × turnsBodyInContext × rate
```

Symmetric, principled, harness-agnostic. The only hard part is detecting when the body entered context — and Anthropic's cache-creation token deltas already encode that signal.

**Important: this changes the meaning of `activeDollars`.** Numbers will be much smaller after migration. Existing tests and UI labels need updating. This is intentional — the new number is the actually-meaningful one. Document the migration in the README and a short blog/changelog entry.

---

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Active cost definition | Body tokens × turns body present × rate | Principled marginal cost, harness-agnostic |
| Activation detection signal | `cache_creation_input_tokens` delta | Exact API-level signal, in JSONL today |
| Fallback signal | `<command-name>` markers | Corroborates cache delta; fills gaps if delta is ambiguous |
| Tokenizer | `@anthropic-ai/tokenizer` (local) | ~18% more accurate than `bytes/4`, no network |
| Multi-skill simultaneous activation | Subset-sum match within tolerance | Real edge case (CLAUDE.md-loaded multi-skill) |
| Compaction handling | Reset injected set on `context_management` events | Cache invalidation = effective re-injection on next turn |
| Body cost cache state | First-turn-after-activation = `cache_create`, subsequent = `cache_read` | Matches Anthropic's actual cache billing |
| Listing cost cache state | First turn of session = `cache_create`, subsequent = `cache_read` | Same model as body, applied to listing |
| Migration approach | Replace, don't add a third axis | Two axes is comprehensible; three is clutter |

---

## Files to read first

```
server/src/usage/parser.ts          — UsageTurn shape, parseAllSessions, findSessionFiles
server/src/usage/attributor.ts      — current active cost (will be substantially rewritten)
server/src/usage/loaded.ts          — current loaded cost (will be substantially rewritten)
server/src/usage/aggregate.ts       — combines into SkillCostSummary
server/src/usage/pricing.ts         — getPricing, toDollars
server/src/scanner/discover.ts      — discoverAllSkills returns Skill[] with .body
server/src/scanner/types.ts         — Skill type
server/src/__tests__/attributor.test.ts — will need updating (numbers shift)
server/src/__tests__/loaded.test.ts — same
docs/cost-calculations.md           — accuracy framework (will need updating after this lands)
```

---

## Phase A — Foundation

### A1. Install tokenizer

```bash
npm install @anthropic-ai/tokenizer
```

Local, ~1.4 MB, uses tiktoken WASM + Anthropic's `claude.json` BPE table.

### A2. New module: `server/src/usage/tokenizer.ts`

Centralize tokenizer use behind one helper so it's swappable later (e.g., for a Cursor variant or for the SDK's `messages.countTokens`).

```typescript
import { countTokens as anthropicCountTokens } from '@anthropic-ai/tokenizer'

export function countTokens(text: string): number {
  if (!text) return 0
  return anthropicCountTokens(text)
}
```

Don't import `@anthropic-ai/tokenizer` directly anywhere else in the codebase. Always go through this module.

### A3. Capture body bytes/tokens during scanner

In `server/src/scanner/discover.ts` (or wherever skill body is read), add to the `Skill` shape:

```typescript
interface Skill {
  // ... existing fields
  bodyBytes: number      // already implicitly known from body.length
  bodyTokens: number     // NEW — countTokens(body), computed once at discovery
  listingBytes: number   // NEW — current listingBytesFor logic moves here
  listingTokens: number  // NEW — countTokens(listing)
}
```

Where `listing` = `${name} ${truncatedDescription}` per existing `listingBytesFor()` logic in `loaded.ts`.

Skills that are commands keep `bodyTokens` populated — the body still gets injected on `/foo` invocation, so it has body cost too. (Today the loaded computation excludes commands; that stays. Active computation must INCLUDE commands.)

### A4. Tokenizer warm-up

The first call to `countTokens` is slow (WASM init). Warm it once on server start by calling `countTokens('')` in `index.ts` startup.

### A5. Tests

`server/src/__tests__/tokenizer.test.ts`:
- Empty string → 0 tokens.
- Known sample ("hello world") → known token count.
- Unicode normalization — same string with different combining-character forms → same count.

---

## Phase B — Activation detection

### B1. New module: `server/src/usage/activation.ts`

```typescript
export interface ActivationEvent {
  sessionId: string
  turnIndex: number          // 0-based index of the assistant turn within session
  timestamp: string
  injectedSkills: string[]   // skill names that became active on this turn
  cacheCreateDelta: number   // tokens; how much the cache prefix grew
  unexplainedDelta: number   // delta tokens not attributed to any skill
}

export function detectActivations(
  validSkills: SkillTokenInfo[],   // { name, bodyTokens } from scanner
  since?: Date,
): ActivationEvent[]
```

### B2. Algorithm

For each session JSONL (use `findSessionFiles()`):

1. **Sort lines by timestamp** within the file (defensive; usually already in order).
2. Track per-session state:
   ```typescript
   let prevCacheRead = 0        // approximate "size of cached prefix at last turn"
   let injectedNames = new Set<string>()
   let turnIndex = -1
   ```
3. Walk lines:
   - **`<command-name>` user turn:** record this as a "hint" — the next assistant turn likely activates this skill. Helps disambiguate sums in step 4.
   - **`context_management` event** (`message.context_management` non-null): treat as compaction. Clear `injectedNames`, reset `prevCacheRead` to 0. All injected bodies effectively re-enter on the next turn.
   - **Assistant turn:**
     - `turnIndex++`
     - Read `cache_creation_input_tokens` (`cc`) and `cache_read_input_tokens` (`cr`) from `message.usage`.
     - **Activation signal:** `delta = cc` — the bytes that joined the cached prefix on this turn.
     - If `delta > MIN_DELTA_TOLERANCE` (e.g., 200 tokens), look for a subset of `validSkills` whose `bodyTokens` sum matches `delta` within ±15% tolerance and whose names aren't already in `injectedNames`.
       - Prefer single-skill matches over multi-skill sums.
       - Use the slash-command hint (if any) as a tiebreaker.
       - If multiple equally-good single-skill matches, attribute to all of them (you can't distinguish).
     - Add matched skills to `injectedNames`.
     - Emit an `ActivationEvent` for this turn.
     - Update `prevCacheRead = cr + cc`.
4. Return all events sorted by `(sessionId, turnIndex)`.

**Subset-sum detail:** in practice, sessions almost always activate one skill at a time. Don't waste cycles on N-skill subsets — limit search to single-skill matches plus pairs of skills. Beyond that, log as `unexplainedDelta` and move on.

### B3. Tolerance tuning

Body size in tokens is tokenized at scanner time using `countTokens`. The cache-creation delta from the API will be close but not exact because:
- The API counts the full system prompt fragment (with framing tokens around the body)
- Tokenization vocabulary mismatches (Claude 3+ vocab vs the bundled `claude.json` vocab)

A tolerance of ±15% catches real activations without too many false positives. If tuning shows otherwise, document in code.

### B4. Tests

`server/src/__tests__/activation.test.ts`:
- Single skill, slash-invoked, single-turn body present → detected with cache-create delta matching body.
- Single skill, auto-triggered (no slash command), cache-create delta matches body → detected.
- Two skills auto-triggered at different turns → both detected, in order.
- Compaction event mid-session → injected set resets, next activation re-detected.
- Cache delta doesn't match any skill → emitted as `unexplainedDelta`, no false attribution.
- Two skills could each explain the same delta → both attributed (ambiguous case documented).

---

## Phase C — New cost computation

### C1. Rewrite `loaded.ts`

```typescript
export interface LoadedCostEntry {
  skillName: string
  listingBytes: number
  listingTokens: number
  loadedTurns: number          // count of assistant turns where skill was loaded
  cacheCreationTokens: number  // listing tokens charged at cache_create rate (first turn of session)
  cacheReadTokens: number      // listing tokens charged at cache_read rate (subsequent turns)
  totalDollars: number
}
```

For each assistant turn in scope:
- For each skill in `validSkills` (excluding commands):
  - Compute `effectiveListingTokens = skill.listingTokens × effectiveScale` (8000-byte budget cap stays in bytes — convert via `listingBytes × effectiveScale / listingBytes` ratio applied to tokens).
  - If this is the first turn of this `sessionId` → charge as `cache_create`.
  - Else → charge as `cache_read`.
  - Attribute to the skill.

The 8000-byte budget cap is computed as before from `sum(listingBytes for non-command skills)`.

### C2. Rewrite `attributor.ts` → rename to `active.ts`

Old `attributor.ts` deletes; new `active.ts` does:

```typescript
export interface ActiveCostEntry {
  skillName: string
  bodyBytes: number
  bodyTokens: number
  activations: number          // count of activation events for this skill
  activeTurns: number          // total turns where skill body was in context
  cacheCreationTokens: number  // body tokens at cache_create rate (one per activation)
  cacheReadTokens: number      // body tokens at cache_read rate (every subsequent turn until compaction/session end)
  totalDollars: number
  lastActivated: string        // ISO timestamp of most recent activation
}
```

Algorithm:

1. Run `detectActivations()` to get all events.
2. Walk session JSONLs again. For each session:
   - Maintain `activeSkills: Set<string>` (driven by the activation events for this session).
   - For each assistant turn:
     - Look up activation events at this `turnIndex`. If any, add their skills to `activeSkills`. For each newly-activated skill, charge `bodyTokens` at `cache_create` rate (this turn).
     - For each skill already in `activeSkills` (not just-added this turn), charge `bodyTokens` at `cache_read` rate.
     - On compaction event, clear `activeSkills`.
3. Aggregate per-skill across all sessions.

### C3. Update `aggregate.ts`

`SkillCostSummary` shape stays the same (`active`, `loaded`, `total`). The numerical content changes substantially — that's fine.

### C4. Tests — substantial rewrite

`server/src/__tests__/active.test.ts` (renamed from attributor.test.ts):
- All existing tests' expected values shift. Update fixtures.
- Add tests for auto-triggered skill (no slash command) → active cost > 0.
- Add tests for command body cost (commands now have active cost when invoked).
- Add test: skill activated then compacted then re-activated → two `cache_create` charges.

`server/src/__tests__/loaded.test.ts`:
- Cache-state model change (per-session first-turn cache_create) shifts expected numbers.
- Tokenizer change (4.7 vs 4.0 bytes/token) shifts expected numbers.
- Update fixtures.

---

## Phase D — Migration

### D1. README + cost-calculations.md update

Update `docs/cost-calculations.md` to reflect the new model. Specifically:
- Active cost section: rewrite. New definition, new algorithm, new accuracy bounds.
- Add a "Migration from v1" appendix briefly noting that pre-Phase-15 active dollars were window-cost, post-Phase-15 are body-cost.

### D2. UI label tweaks

In the inventory table and detail drawer:
- Active $ tooltip: change from "Cost while skill was running" to "Cost of this skill's body sitting in context across turns it was loaded."
- Loaded $ tooltip: clarify "Cost of this skill's listing in the system prompt across every turn."
- No column-name changes needed.

### D3. API stability

`/api/usage/aggregate` response shape unchanged. Numerical content changes. Frontend doesn't need changes beyond tooltip strings.

### D4. Sanity diff

After implementation, run the dev server and compare a few skills' before/after numbers. Expected:
- Loaded $: ~10–25% lower (tokenizer fix + cache_read pricing).
- Active $: substantially lower for most skills (window-cost → body-cost) BUT non-zero for skills that were previously $0 because they were only auto-triggered.
- Net total: highly variable per skill. Likely lower overall, but skills that were "free" because they were auto-triggered now show real cost.

Document the deltas in commit message.

---

## Phase E — Cursor parity prep (out of scope for this phase, hooks only)

To make Phase 15 cleanly extensible to Cursor later, structure the activation detection so it's harness-agnostic:

```typescript
interface ActivationDetector {
  detect(sessionData: SessionData, validSkills: SkillTokenInfo[]): ActivationEvent[]
}

// Claude Code implementation: uses cache_creation_input_tokens deltas
class ClaudeCodeActivationDetector implements ActivationDetector { ... }

// Cursor implementation (future): uses inputTokens deltas (no cache breakdown)
class CursorActivationDetector implements ActivationDetector { ... }
```

`SessionData` is a normalized turn list with: `{turnIndex, timestamp, model, inputTokens, outputTokens, cacheCreationTokens?, cacheReadTokens?, commandName?, isCompaction}`.

Don't actually build the Cursor detector in this phase — just structure the Claude Code one as if you'll have a Cursor sibling later. This is cheap to do up-front and expensive to refactor in.

---

## Phase F — Verify

1. `npm test` — all tests pass with updated expectations.
2. `node_modules/.bin/tsc -p tsconfig.server.json --noEmit` — clean (modulo pre-existing `stdioClient.ts` errors).
3. `node_modules/.bin/tsc -p client/tsconfig.json --noEmit` — clean.
4. Curl: `curl -s 'localhost:3001/api/usage/aggregate?timeframe=week' | jq '.summaries[0:5]'` — eyeball top 5 skills, verify the active + loaded numbers look plausible.
5. Spot-check: pick a skill you know is auto-triggered (never slash-invoked). Pre-Phase-15 it had `active: $0`. Post-Phase-15 it should have `active > 0` if you used it this week.
6. Spot-check: pick a skill you slash-invoke regularly. Pre-Phase-15 active was big; post-Phase-15 should be smaller (just body cost, not window cost).
7. UI: load the dev server, hover the active $ tooltip, confirm new wording.

---

## Constraints

- **One new dependency:** `@anthropic-ai/tokenizer`. No others.
- **Don't touch the API response shape** (`/api/usage/aggregate`, `/api/inventory`). Numerical content changes; field names don't.
- **Keep the existing 8000-byte listing budget cap.** It's a real Claude Code constraint, not an artifact of the old code.
- **Tests must pass** — but expected values get rewritten where the algorithm changed.
- **Don't bake Cursor-specific assumptions in.** Design the activation detector with a hot-swap interface.

---

## Risk notes

- **Tokenizer vocabulary mismatch.** `@anthropic-ai/tokenizer`'s vocab is from 2023 (Claude 1/2 era). Modern Claude vocab differs. Empirical error vs ground truth is small (probably <5%); within the activation-detection tolerance band.

- **Activation detection ambiguity.** Two skills with similar body sizes activated in close turns will sometimes attribute to the wrong one. Real edge case. Mitigation: prefer slash-command hints when present; document the ambiguity in the README.

- **Compaction loses fine-grained history.** After compaction, all bodies effectively re-enter cache. We treat this as "re-activation" of all currently-injected skills on the next turn. This is correct from a billing standpoint but means a long session with multiple compactions will show inflated activation counts. Document.

- **Subagent attribution is still broken.** Sidechain turns have their own context — they don't see the parent's cache. Phase 17 fixes this. Phase 15 just doesn't make it worse.

- **Tool definitions and other system-prompt content also contribute to `cache_creation_input_tokens` deltas.** When a new MCP server connects mid-session, its tool schemas would look like an "activation" by token delta. Mitigation: only consider deltas explainable by a known skill body within tolerance. Unmatched deltas go into `unexplainedDelta` and aren't attributed. This is the right behavior.

- **Backwards compat for users.** Pre-Phase-15 cost numbers persisted in user expectations ("my morning-plan skill costs $5/week"). Post-Phase-15 those numbers will look different. Communicate clearly in the changelog.

---

## Open questions for implementer

These are decisions that need calibration against real data:

1. **`MIN_DELTA_TOLERANCE`** — what's the smallest cache-creation delta worth investigating? Probably 200 tokens (smaller than any plausible skill body). Tune after running against real sessions.

2. **Subset-sum search depth.** Single-skill, two-skill, three-skill? Likely two is enough; benchmark against a real `~/.claude/projects` and see how often three-skill matches occur.

3. **What to do about `unexplainedDelta`.** Ignore? Surface as a per-session "unattributed cost" line? For Phase 15: ignore (it's noise from other system-prompt content). For Phase 20 dashboard: surface aggregate.

4. **Tokenizer cache.** Tokenizing every skill body on every server restart is fine for current scale (~50 skills). At 500+ skills it's slower. Cache `bodyTokens` in `~/.local-skill-manager/token-cache.json` keyed by `(skillId, bodyHash)`. Probably out of scope for Phase 15; do later if perf complaints.

---

## Implementation order (for the implementer)

1. Phase A1–A2 (tokenizer install + helper module). 30 min.
2. Phase A3–A4 (scanner captures bodyTokens / listingTokens). 1–2 hr.
3. Phase A5 (tokenizer tests). 30 min.
4. Phase B1–B3 (activation detector). 4–6 hr — this is the core work.
5. Phase B4 (activation tests). 2 hr.
6. Phase C1 (loaded rewrite). 2 hr.
7. Phase C2 (active rewrite). 3 hr.
8. Phase C4 (test rewrites). 3–4 hr.
9. Phase D (migration: docs, UI tooltips, sanity diffs). 1–2 hr.
10. Phase E (Cursor-prep refactor). 1 hr.
11. Phase F (verify). 1 hr.

Total: ~20 hours of focused work. Land in 2–3 sessions, not one.

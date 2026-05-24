# Signal-Detection Pipeline

Implementation of the design in [`docs/signal-detection-pipeline.md`](../../../../docs/signal-detection-pipeline.md). Tracked in Linear under **LOC-69** (architecture) and **LOC-70**..**LOC-79** (implementation phases).

The pipeline replaces the legacy free-form digest (`../digest.ts`) with a multi-phase extractor that separates **detection** from **synthesis**, operates on sub-goal **arcs** rather than whole conversations, and runs **four parallel detectors** with type-specific bars.

## Feature flag

Both pipelines stay in the codebase until the new one is tuned on real data. Dispatch happens in `../digest.ts`:

```ts
if (settings.autoSkill.useSignalPipeline) {
  return runSignalPipeline(opts)   // this directory
}
return runDigest(opts)              // legacy free-form digest
```

The flag is added in LOC-70 (default `false`); LOC-79 flips it on after a tuning pass against real corpora.

## Phase map

| Phase | Module | What it does | LLM calls (cold / warm) |
|---|---|---|---|
| 0 — Arc segmentation | `arcs.ts` | Split each conversation into sub-goal arcs via heuristics (topic-shift phrases, time gap > 30 min, cwd shift, resolution→new-ask). LLM fallback fires only when heuristics yield 0 boundaries on a > 40-turn conversation. | 0–1 per long convo / 0 |
| 1 — Per-arc summarize | `summarize.ts` + `summaryCache.ts` | Small-model LLM call per arc produces a `ConversationSummary` (intent / slots / steps / outcome / etc.). Content-hashed cache at `~/.loadoutsmith/signals/summaries.json`. Filters failed + unstable arcs (no skill signal). | 1 per arc / 0 (cache hit) |
| 2 — Centroid clustering | `cluster.ts` + `embed.ts` | Deterministic k-means over normalized sentence embeddings of `intent + sorted slot values`. Elbow heuristic picks k. Drops clusters with < 3 members or < 60% success rate. | N embedding calls / 0 |
| 3a — Rule detector | `detectors/rules.ts` | Mines directives from `personalizationSignals` + `correctionMarkers`. Requires ≥ 5 conversations + cross-cluster spread. Single batch LLM classifier (convention vs task-specific). Dedups vs `<!-- LS-rule:* -->` markers in CLAUDE.md / AGENTS.md. | 1 (batch) / 1 |
| 3b — Command detector | `detectors/commands.ts` | Pools `verbatimUserPrompts`, groups near-dupes via Levenshtein. Filters prompts < 100 chars or mostly code/paths. Dedups vs existing commands. | 0 / 0 |
| 3c — Skill detector | `detectors/skills.ts` | Per cluster: pre-filter → synth `S = (C, π, T, R)` (1 LLM call, 1 retry on malformed) → programmatic consistency check on 2 held-out members (1 batched LLM call, NSI-style). Drop if 0/2 pass. | 2 per surviving cluster / 2 |
| 3d — Subagent detector | `detectors/subagents.ts` | Skill-tag each arc, mine recurring contiguous n-grams across conversations (≥ 3 distinct convos, length 2..6). Subsumption dedup. Bounded-shape filter (≥ 2/3 instances end successfully). Synth the orchestration shape. | 1 per surviving pattern / 1 |
| 4 — Dedup | `dedup.ts` | Embed candidate `name + description`, compare to existing same-kind artifacts. Cosine sim > 0.8 → populate the existing `Candidate.existingMatch` field. Candidates are NOT dropped; the UI shows a "refines existing X" badge. | embedding-only |
| 5 — Type-specific rank | `rank.ts` | Per-kind formula populates `Candidate.score`. Skills boost on personalization signal count (SkillsBench finding: software engineering is the low-gain domain — personalization is where the value is). Top-K (10 by default) per kind. | 0 |
| 6 — `reasonForUser` | `explain.ts` | Templated plain-English explanation per candidate. Refinement preamble prepended when `existingMatch` is set. | 0 |
| Persist | `runPipeline.ts` | Each annotated candidate goes through `store.upsertGenerated()` — the same store the legacy digest uses. Signature-keyed dedup; merged sourceRefs; preserves user-triaged status across runs. | 0 |

## Research backing

Each design choice traces back to a verified primary source:

- **arXiv 2602.12670 — SkillsBench**: strict bar for skill candidates; software-engineering is a low-gain domain → bias toward personalization signals.
- **arXiv 2602.20867 — SoK Agentic Skills**: formal `S = (C, π, T, R)` structure → skill detector emits exactly these four fields.
- **arXiv 2502.17321 — Choubey et al. (Turning Conversations into Workflows)**: extract procedural elements before clustering; centroid > diversity; less data > more; no refinement loops.
- **arXiv 2605.01293 — Lifting Traces to Logic (NSI)**: programmatic consistency check as skill validator → skill detector's 2-of-2 holdout pass.

See `docs/signal-detection-pipeline.md` for the prose discussion of each choice and what the pipeline deliberately does NOT do.

## File layout

```
signals/
├── README.md                ← you are here
├── runPipeline.ts           ← orchestrator (LOC-79)
├── types.ts                 ← intermediate types: SubGoalArc, ConversationSummary, IntentCluster
├── index.ts                 ← public barrel
├── arcs.ts                  ← Phase 0 (LOC-71)
├── summarize.ts             ← Phase 1 (LOC-72)
├── summaryCache.ts          ← Phase 1 cache
├── embed.ts                 ← embedding wrapper around ollama.embeddings
├── cluster.ts               ← Phase 2 (LOC-73)
├── dedup.ts                 ← Phase 4 (LOC-77)
├── rank.ts                  ← Phase 5 (LOC-77)
├── explain.ts               ← Phase 6 (LOC-77)
├── detectors/
│   ├── rules.ts             ← Detector A (LOC-74)
│   ├── commands.ts          ← Detector B (LOC-74)
│   ├── skills.ts            ← Detector C (LOC-75)
│   └── subagents.ts         ← Detector D (LOC-76)
└── lib/
    ├── levenshtein.ts       ← string-distance helper for commands + rules
    └── ruleMarkers.ts       ← LS-rule:<id> marker helpers + existing-md reader
```

Tests live flat in `server/src/__tests__/signals*.test.ts` (LOC-69 audit convention).

## Where the LLM defaults live

The detectors are designed to be **injectable** so unit tests run hermetically. The orchestrator (`runPipeline.ts`) supplies real Ollama-backed defaults:

- **Summarizer** → `ollama.generate({ json: true, temperature: 0.2 })` with the user-selected model.
- **Rule classifier** → single batched call ("classify each directive as CONVENTION vs TASK-SPECIFIC, return JSON array of booleans").
- **Skill synth** + **consistency** → defaults in `detectors/skills.ts` route directly to `ollama.generate`.
- **Subagent synth** → default in `detectors/subagents.ts`.
- **Embeddings** → `embed.ts` wraps `ollama.embeddings({ model: 'nomic-embed-text' })`. The "model not pulled" 404 surfaces a clear `ollama pull` instruction (LOC-70).

## Cost model (cold cache)

For a corpus of N conversations producing K arcs and C surviving clusters:

| Phase | LLM calls | Embedding calls |
|---|---|---|
| Arc segmentation | 0 (heuristic-only on most conversations) | 0 |
| Per-arc summarize | K | 0 |
| Cluster | 0 | K |
| Rule detector | 1 (batch) | up to E (existing rule files; usually 1–3) |
| Command detector | 0 | 0 |
| Skill detector | 2C | 0 |
| Subagent detector | up to P (surviving patterns) | per-arc skill tagging when no `invokedSkills` |
| Dedup | 0 | M (candidates emitted) |

For a typical corpus (~200 conversations → ~400 arcs → ~20 surviving clusters): cold ≈ 440 LLM calls. Warm cache ≈ 40. Most calls are parallelizable across the four detectors.

## Known gap (deferred)

Rule candidates land as **text blocks inside** CLAUDE.md / AGENTS.md, not as standalone files. The existing scanner finds file-based artifacts only, so accepted rules don't appear in the inventory and can't be cleanly uninstalled. LOC-78 ships a forward-compat workaround: every appended rule is wrapped in `<!-- LS-rule:<stable-id> start --> … <!-- LS-rule:<stable-id> end -->` markers. A future ticket will add a parser to surface them as a tracked artifact kind. See LOC-69's "Known gap deferred" comment for the full discussion.

# Local Loadout Smithery

<img width="250" height="300" alt="image" src="https://github.com/user-attachments/assets/6ac8b937-ae0c-4d0d-82aa-018349d8d837" />

The control panel for your Claude Code loadout. See every skill, slash command, subagent, and MCP server you have, what each one costs in tokens, and which ones aren't pulling their weight — all in one place.

## Install

```bash
npm install -g local-loadout-smithery
```

Requires Node.js 18+.

## Run

```bash
local-loadout-smithery     # full name
lls                        # short alias
```

Opens the UI in your browser at `http://localhost:5173` (dev) or `http://localhost:3001` (production build).

## First-time setup

No configuration required — the app discovers your loadout automatically by scanning `~/.claude` (and any additional account dirs like `~/.claude-work`) for skills, commands, subagents, and MCP server definitions.

**Optional:** customize pricing for cost calculations by creating `~/.loadoutsmith/pricing.json`. Defaults ship for current Claude models; override any model's rates in that file to match Anthropic's published pricing.

## Why use it

Loadout artifacts left unmanaged accumulate quietly. Every enabled skill, command listing, subagent, and MCP tool is loaded into every conversation context, whether you invoked it or not. That loaded context costs tokens on every turn — and most of it is never actually invoked.

Local Loadout Smithery shows you which artifacts are earning their keep and which are pure overhead:

- **🚨 Removal candidates** — artifacts with meaningful loaded cost but zero active usage. They're taxing every conversation and doing nothing in return.
- **💤 Dormant artifacts** — items you haven't invoked in 90+ days. Probably forgotten, definitely still costing you.
- **✅ Winners** — high loaded cost AND high active usage. These are pulling their weight.

The diagnostic view puts the removal candidates and dormant items in one filtered list so you can act on them in one pass.

## The auto-invocation problem

Skills and subagents are designed to fire automatically when their description matches what you're asking for. **In practice, they often don't.** This is an active, ongoing issue across the Claude Code community:

- **GitHub Issue [#47598](https://github.com/anthropics/claude-code/issues/47598)** *(Opus 4.6, open)* — *"Claude Code stopped delegating to custom subagents and loading skills — regression persists in Opus 4.6."* Reporter has 8 specialist agents and 7 skills with YAML triggers, all working in Jan–Feb 2026 and broken since March. April 2026 comment reports the regression is *"degrading instead of improving"* over the prior two weeks.
- **GitHub Issue [#51099](https://github.com/anthropics/claude-code/issues/51099)** *(Opus 4.7, open)* — Reporter explicitly instructed the agent to use installed skills **at least seven times** in one session. Agent acknowledged each time, then either skipped the skill, called it only for data gathering and wrote generic code by hand, or produced meta-documents instead of actual output. Multi-hour session, heavy token spend, near-zero deliverable progress.
- **Anthropic's own [Opus 4.7 best-practices guide](https://claude.com/blog/best-practices-for-using-claude-opus-4-7-with-claude-code)** acknowledges the shift: *"Opus 4.7 tends to be more judicious about when to delegate work to subagents."* In other words, fewer subagent invocations by default — confirming the auto-routing problem is worse on the newer model, not better.
- A 650-trial benchmark ([Medium](https://medium.com/@ivan.seleznov1/why-claude-code-skills-dont-activate-and-how-to-fix-it-86f679409af1)) puts autonomous skill activation at **~50%** even with valid YAML and clear descriptions — "a coin flip."
- Multiple 2026 community write-ups ([scottspence.com](https://scottspence.com/posts/claude-code-skills-dont-auto-activate), [DEV.to](https://dev.to/lizechengnet/why-claude-code-skills-dont-trigger-and-how-to-fix-them-in-2026-o7h)) confirm the same pattern: skills are visible in the listing, but Claude rarely reaches for them.

### Why it happens

1. **The model is goal-focused.** It prioritizes finishing the task as it understands it, not auditing whether a skill exists for it.
2. **Token budget overflow.** When the listing exceeds ~15K characters, descriptions get silently truncated. Skills toward the bottom never appear in context at all.
3. **Vague descriptions.** *"Helps with tests"* gets ignored. *"When the user asks to run, check, or verify tests, run pytest"* gets picked up. The description is the trigger, not the instructions.

### Why it matters here

This is exactly why the *removal candidate* and *dormant* diagnostics exist. A skill with meaningful loaded cost but zero invocations isn't unused because you don't need it — it's unused because the router never picked it up. The smithery surfaces those artifacts so you can either rewrite the description or delete the artifact.

### What works (community-converged fixes)

- **Directive descriptions** — *"ALWAYS invoke this when... Do not handle this directly"* hits ~100% activation in trials, vs. ~37% for standard descriptions.
- **UserPromptSubmit hooks** — shell hooks that match prompts against keyword rules and inject *"use skill X"* before the model sees the prompt. Bypasses the router entirely.
- **CLAUDE.md routing rules** — less precise than hooks but no setup; *"When user says X, use skill Y."*

## What it does

- **Inventory** — unified view of all your Claude Code skills, slash commands, subagents, and MCP server tools across all accounts and scopes
- **Token tracking** — dual-axis cost per artifact: active cost (when invoked) + loaded cost (context tax on every turn), in tokens and dollars. See [`COST_MODEL.md`](./COST_MODEL.md) for the full spec.
- **Health diagnostics** — frontmatter linter, broken symlink detection, and health badges with inline issue descriptions
- **Diagnostic insights** — surfaces removal candidates and dormant artifacts; "Needs review" filter + inline insight banner
- **SuperRouter** — group skills behind a trigger condition. Toggle a bundle on and the trigger block lands in `CLAUDE.md` (or your Cursor MD), with a sibling map file listing the skills to consider only when that trigger matches. Cuts context tax for skills that only apply some of the time.
- **Auto Skill** — find candidate skills hidden in your own chat history. Extracts conversations from Claude Code, Cursor, and Codex (when present), runs them through a local Ollama model, and surfaces suggested skills / commands / subagents you can accept with one click. Conversation text is **deleted from disk** after digest — only short excerpts persist on each candidate for traceability.

Everything runs locally. No data leaves your machine.

## Auto Skill — setup

Auto Skill needs a local LLM. We use [Ollama](https://ollama.com) because
it's a single binary, no API keys, no telemetry.

```bash
brew install ollama                # macOS — or grab the installer from ollama.com
brew services start ollama         # background daemon, restarts on login
ollama pull qwen2.5:3b             # ~2 GB, the recommended default
```

Model sizing — pick what fits your machine:

| RAM | Suggested model | Size on disk | Digest time on ~60 conversations |
| --- | --- | --- | --- |
| 8 GB+ | `qwen2.5:3b` *(default)* | ~2 GB | ~10 min on Apple Silicon |
| 16 GB+ | `qwen2.5:7b` | ~4.7 GB | ~30 min |
| 32 GB+ | `qwen2.5:14b` | ~9 GB | even longer |

The 3B is the right default. For classification + structured extraction (which is all the Auto Skill does), the quality difference vs. 7B is small and the speed difference is large. Upgrade to 7B only if you find the 3B's candidates noticeably weaker.

The Auto Skill panel auto-detects installed models — `ollama pull` whichever
ones you want and they appear in the dropdown.

If Ollama isn't installed, the Auto Skill button still appears; the panel
shows the install commands instead of the candidate list. Every other
feature in the app continues to work without it.

Once Ollama is running, open **✨ Auto Skill** in the header, pick a model
and a lookback window (default: 2 weeks), then click **Run digest**.
Conversations get extracted to `~/.loadoutsmith/conversations/`, fed
through the model, and deleted on success. The resulting candidates show
up in the panel — review, edit, and accept whichever ones turn into real
skills in your loadout.

**Duplicate detection.** Each candidate is automatically cross-referenced
against your existing inventory. Skills with a matching name or similar
description get a *🔁 already in loadout* badge. Click **Compare** on
those rows to have the local model diff the candidate against the
existing skill and propose concrete additions — useful when the
candidate has captured nuance worth merging into the existing file
rather than starting fresh.

**Two-pass synthesis.** The discovery digest runs on the small model
(qwen2.5:3b default) and finds candidates fast. When you click **Accept**
on one, the modal exposes a model picker + **Regenerate body** button —
that runs a bigger model (e.g. qwen2.5:7b) just on that one candidate to
write a richer body. Per-candidate synthesis takes ~10–30 s; you only
pay for it on candidates you actually want.

**Caveat — body quality is bounded by surviving context.** After a
successful digest the raw conversation text is deleted from disk (privacy
default). Candidates keep only ~120-char excerpts per source ref, so the
synthesizer has limited material to work from and will sometimes
invent plausible-but-incorrect details. Treat the regenerated body as a
draft to edit, not a finished skill. (A future change will re-pull the
original conversation on demand for synthesis — work tracked in
`planning_notes/AUTO_SKILL.md`.)

**Single-model-at-a-time.** The app loads at most one model into RAM.
Switching models mid-session (3B for discovery → 7B for synthesis)
evicts the previous model before pulling the new one in, so you never
hold two large weights side-by-side.

**On shutdown.** Pressing Ctrl+C unloads whatever model this process
loaded — RAM frees immediately rather than waiting out Ollama's ~5 min
keep_alive. The Ollama daemon itself keeps running (so the next startup
is instant). Only the model weights get evicted, and only the model this
app loaded — any unrelated Ollama clients on your machine are untouched.

## Where data lives

Everything the app writes lives under `~/.loadoutsmith/`. Inspecting or
deleting any of these is safe; the app rebuilds what it needs.

| Path | Purpose | Lifecycle |
| --- | --- | --- |
| `settings.json` | App settings (currently just the chosen Ollama model) | Persistent |
| `auto-skill/candidates.json` | Generated candidates + status | Persistent |
| `conversations/<source>/<date>.jsonl` | Extracted chat history during a digest run | Deleted after successful digest |
| `conversations/.last-extract.json` | Per-source high-water mark for incremental extracts | Persistent |
| `super-router.json` | SuperRouter bundle definitions | Persistent |
| `super-router/<slug>.md` | Skill map files for enabled bundles | Created/removed by bundle toggle |
| `move-log.jsonl` | Audit log for skill reclassifications | Append-only |
| `cursor-projects-seen.jsonl` | Cache of discovered Cursor projects | Append-only |

If you ever want a clean slate: `rm -rf ~/.loadoutsmith/` then restart
the app.

## Screenshot

*(coming soon)*

## Development

```bash
git clone https://github.com/yourusername/local-loadout-smithery
cd local-loadout-smithery
npm install && cd client && npm install && cd ..
npm run dev
```

## License

MIT

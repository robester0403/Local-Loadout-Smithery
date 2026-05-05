# Local Skill Manager

The control panel for your Claude Code skill library. See what skills you have, what they cost in tokens, and which ones aren't performing — all in one place.

## Install

```bash
npm install -g local-skill-manager
```

Requires Node.js 18+.

## Run

```bash
local-skill-manager
```

Opens the UI in your browser at `http://localhost:5173` (dev) or `http://localhost:3001` (production build).

## First-time setup

No configuration required — LSM discovers your skills automatically by scanning `~/.claude` (and any additional account dirs like `~/.claude-work`) for skills, commands, and agents.

**Optional:** customize pricing for cost calculations by creating `~/.local-skill-manager/pricing.json`. LSM ships with hardcoded defaults for current Claude models; override any model's rates in that file to match Anthropic's published pricing.

## Why use it

Skills left unmanaged accumulate quietly. Every skill you have enabled is loaded into every conversation context, whether you invoked it or not. That loaded context costs tokens on every turn — and most skills are never actually invoked.

Local Skill Manager shows you which skills are earning their keep and which are pure overhead:

- **🚨 Removal candidates** — skills with meaningful loaded cost but zero active usage. They're taxing every conversation and doing nothing in return.
- **💤 Dormant skills** — skills you haven't invoked in 90+ days. Probably forgotten, definitely still costing you.
- **✅ Winners** — high loaded cost AND high active usage. These are pulling their weight.

The diagnostic view puts the removal candidates and dormant skills in one filtered list so you can act on them in one pass.

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

### Why this matters for LSM

This is exactly why the *removal candidate* and *dormant* diagnostics exist. A skill with meaningful loaded cost but zero invocations isn't unused because you don't need it — it's unused because the router never picked it up. LSM surfaces those skills so you can either rewrite the description or delete the skill.

### What works (community-converged fixes)

- **Directive descriptions** — *"ALWAYS invoke this when... Do not handle this directly"* hits ~100% activation in trials, vs. ~37% for standard descriptions.
- **UserPromptSubmit hooks** — shell hooks that match prompts against keyword rules and inject *"use skill X"* before the model sees the prompt. Bypasses the router entirely.
- **CLAUDE.md routing rules** — less precise than hooks but no setup; *"When user says X, use skill Y."*

## What it does

- **Inventory** — unified view of all your Claude Code skills, commands, and agents across all accounts and scopes
- **Token tracking** — dual-axis cost per skill: active cost (when invoked) + loaded cost (context tax on every turn), in tokens and dollars
- **Health diagnostics** — frontmatter linter, broken symlink detection, and health badges with inline issue descriptions
- **Diagnostic insights** — surfaces removal candidates and dormant skills; "Needs review" filter + inline insight banner

Everything runs locally. No data leaves your machine.

## Screenshot

*(coming soon)*

## Development

```bash
git clone https://github.com/yourusername/local-skill-manager
cd local-skill-manager
npm install && cd client && npm install && cd ..
npm run dev
```

## License

MIT

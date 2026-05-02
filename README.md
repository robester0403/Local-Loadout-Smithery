# Local Skill Manager

The control panel for your Claude Code skill library. See what skills you have, what they cost in tokens, and which ones aren't performing — all in one place.

## Install

```bash
npm install -g local-skill-manager
```

## Run

```bash
local-skill-manager
# Opens in your browser at http://localhost:3001
```

## What it does

- **Inventory** — unified view of all your Claude Code skills, commands, agents, hooks, and MCP servers across all accounts and scopes
- **Token tracking** — dual-axis cost per skill: active cost (invocation) + loaded cost (context tax), in tokens and dollars
- **Health diagnostics** — surfaces broken, dormant, and bloated skills with actionable fix suggestions

Everything runs locally. No data leaves your machine.

## Development

```bash
git clone https://github.com/yourusername/local-skill-manager
cd local-skill-manager
npm install && cd client && npm install && cd ..
npm run dev
```

## License

MIT

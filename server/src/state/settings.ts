import fs from 'fs'
import os from 'os'
import path from 'path'

// App-wide settings live in a single JSON. Adding a new key = new optional
// field here + defaulted in `read()`. Atomic write via rename.

export interface Settings {
  autoSkill: {
    /** Ollama model the discovery digest runs against. Empty until the user picks one. */
    model: string
  }
}

function file(): string {
  return path.join(os.homedir(), '.loadoutsmith', 'settings.json')
}

function defaults(): Settings {
  return { autoSkill: { model: '' } }
}

// One-shot read of the old harvester.* key shape for users carrying state
// from the pre-rename version. Returns the migrated model name or empty.
function migrateLegacyHarvesterKey(raw: Record<string, unknown>): string {
  const legacy = raw['harvester']
  if (legacy && typeof legacy === 'object' && typeof (legacy as { model?: unknown }).model === 'string') {
    return (legacy as { model: string }).model
  }
  return ''
}

export function read(): Settings {
  try {
    if (!fs.existsSync(file())) return defaults()
    const raw = JSON.parse(fs.readFileSync(file(), 'utf-8')) as Record<string, unknown>
    const def = defaults()
    const incoming = (raw['autoSkill'] && typeof raw['autoSkill'] === 'object')
      ? raw['autoSkill'] as Partial<Settings['autoSkill']>
      : {}
    const merged = { ...def.autoSkill, ...incoming }
    if (!merged.model) {
      const legacy = migrateLegacyHarvesterKey(raw)
      if (legacy) merged.model = legacy
    }
    return { autoSkill: merged }
  } catch {
    return defaults()
  }
}

export function write(next: Settings): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  const tmp = file() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, file())
}

export function patch(updates: Partial<Settings>): Settings {
  const cur = read()
  const next: Settings = {
    autoSkill: { ...cur.autoSkill, ...(updates.autoSkill ?? {}) },
  }
  write(next)
  return next
}

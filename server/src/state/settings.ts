import fs from 'fs'
import os from 'os'
import path from 'path'

// App-wide settings live in a single JSON. Adding a new key = new optional
// field here + defaulted in `read()`. Atomic write via rename.

export interface Settings {
  harvester: {
    /** Ollama model the digest pass runs against. Empty until the user picks one. */
    model: string
  }
}

function file(): string {
  return path.join(os.homedir(), '.loadoutsmith', 'settings.json')
}

function defaults(): Settings {
  return { harvester: { model: '' } }
}

export function read(): Settings {
  try {
    if (!fs.existsSync(file())) return defaults()
    const raw = JSON.parse(fs.readFileSync(file(), 'utf-8')) as Partial<Settings>
    const def = defaults()
    return {
      harvester: { ...def.harvester, ...(raw.harvester ?? {}) },
    }
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
    harvester: { ...cur.harvester, ...(updates.harvester ?? {}) },
  }
  write(next)
  return next
}

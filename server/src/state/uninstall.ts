import fs from 'fs'
import path from 'path'
import { LOADOUT_DIR } from '../lib/paths'

const UNINSTALLED_DIR = path.join(LOADOUT_DIR, 'uninstalled')
const UNINSTALLED_LOG = path.join(LOADOUT_DIR, 'uninstalled.json')

export interface UninstalledEntry {
  id: string            // base64 of logical path (sans .disabled suffix)
  name: string
  description: string
  type: string
  scope: string
  account: string
  originalPath: string  // actual path at uninstall time (may end in .disabled)
  uninstalledAt: string
}

function ensureDirs(): void {
  fs.mkdirSync(UNINSTALLED_DIR, { recursive: true })
}

export function loadUninstalled(): UninstalledEntry[] {
  if (!fs.existsSync(UNINSTALLED_LOG)) return []
  try {
    return JSON.parse(fs.readFileSync(UNINSTALLED_LOG, 'utf8')) as UninstalledEntry[]
  } catch {
    return []
  }
}

function saveUninstalled(entries: UninstalledEntry[]): void {
  fs.mkdirSync(LOADOUT_DIR, { recursive: true })
  const tmp = UNINSTALLED_LOG + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2))
  fs.renameSync(tmp, UNINSTALLED_LOG)
}

function stagingPath(id: string): string {
  const safe = id.replace(/\//g, '-').replace(/\+/g, '_').replace(/=/g, '')
  return path.join(UNINSTALLED_DIR, `${safe}.md`)
}

export function uninstallSkill(
  id: string,
  actualPath: string,
  meta: { name: string; description: string; type: string; scope: string; account: string },
): void {
  ensureDirs()
  const dest = stagingPath(id)
  fs.copyFileSync(actualPath, dest)
  fs.unlinkSync(actualPath)

  const entry: UninstalledEntry = {
    id,
    name: meta.name,
    description: meta.description,
    type: meta.type,
    scope: meta.scope,
    account: meta.account,
    originalPath: actualPath,
    uninstalledAt: new Date().toISOString(),
  }
  const entries = loadUninstalled()
  const idx = entries.findIndex(e => e.id === id)
  if (idx >= 0) entries[idx] = entry
  else entries.push(entry)
  saveUninstalled(entries)
}

export function restoreSkill(id: string): string {
  const entries = loadUninstalled()
  const entry = entries.find(e => e.id === id)
  if (!entry) throw new Error('Entry not found in trash')

  const src = stagingPath(id)
  if (!fs.existsSync(src)) throw new Error('Staged file not found on disk')

  fs.mkdirSync(path.dirname(entry.originalPath), { recursive: true })
  fs.copyFileSync(src, entry.originalPath)
  fs.unlinkSync(src)

  saveUninstalled(entries.filter(e => e.id !== id))
  return entry.originalPath
}

export function permanentDelete(id: string): void {
  const entries = loadUninstalled()
  if (!entries.find(e => e.id === id)) throw new Error('Entry not found in trash')

  const src = stagingPath(id)
  if (fs.existsSync(src)) fs.unlinkSync(src)

  saveUninstalled(entries.filter(e => e.id !== id))
}

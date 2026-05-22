import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import type { Bundle, BundleInput } from './types'

// Computed lazily so tests can override $HOME before the first call.
function storeFile(): string {
  return path.join(os.homedir(), '.loadoutsmith', 'super-router.json')
}

interface StoreShape {
  bundles: Bundle[]
}

// One-shot migration from the pre-description bundle shape:
//   { skillIds: string[] }  →  { skills: { id, description? }[] }
// Older entries get an empty `skills` array seeded from their `skillIds`. The
// existing entries will fail validation on next enable until the user opens
// each bundle and fills in any missing descriptions — that's deliberate.
function migrateBundle(raw: unknown): Bundle | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown> & Partial<Bundle>
  if (Array.isArray(r.skills)) return r as Bundle
  if (Array.isArray(r.skillIds)) {
    const skills = (r.skillIds as unknown[])
      .filter((id): id is string => typeof id === 'string')
      .map(id => ({ id }))
    const { skillIds: _drop, ...rest } = r
    void _drop
    return { ...rest, skills } as Bundle
  }
  return null
}

function read(): StoreShape {
  const file = storeFile()
  try {
    if (!fs.existsSync(file)) return { bundles: [] }
    const raw = fs.readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<StoreShape>
    if (!Array.isArray(parsed.bundles)) return { bundles: [] }
    const bundles = parsed.bundles
      .map(migrateBundle)
      .filter((b): b is Bundle => b !== null)
    return { bundles }
  } catch {
    return { bundles: [] }
  }
}

// All mutators in this module are synchronous (read → mutate → write via
// fs.*Sync), so Node's single-threaded event loop serializes concurrent
// HTTP requests at the handler boundary — there is no lost-update race
// despite the read-modify-write shape. If anyone converts these to async
// fs.promises calls in the future, wrap the whole sequence in a per-store
// promise-chain mutex first (see LOC-49 discussion).
function write(state: StoreShape): void {
  const file = storeFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Process-and-time-scoped tmp so two server processes (e.g. dev + tests)
  // can't clobber each other's staged writes mid-rename.
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, file)
}

export function listBundles(): Bundle[] {
  return read().bundles
}

export function getBundle(id: string): Bundle | undefined {
  return read().bundles.find(b => b.id === id)
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'bundle'
}

function uniqueSlug(state: StoreShape, base: string, ignoreId?: string): string {
  const taken = new Set(
    state.bundles.filter(b => b.id !== ignoreId).map(b => b.slug),
  )
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}-${i}`)) i += 1
  return `${base}-${i}`
}

function scopeKey(b: { scope: Bundle['scope']; target: Bundle['target'] }): string {
  const scope = b.scope.kind === 'global' ? 'global' : `project:${b.scope.path}`
  return `${b.target}|${scope}`
}

function assertNameUnique(state: StoreShape, input: BundleInput, ignoreId?: string): void {
  const key = scopeKey(input)
  const clash = state.bundles.find(
    b => b.id !== ignoreId && scopeKey(b) === key && b.name === input.name,
  )
  if (clash) {
    throw new Error(`A bundle named "${input.name}" already exists in this scope and target.`)
  }
}

export function createBundle(input: BundleInput): Bundle {
  const state = read()
  assertNameUnique(state, input)
  const now = new Date().toISOString()
  const bundle: Bundle = {
    id: crypto.randomUUID(),
    name: input.name,
    slug: uniqueSlug(state, slugify(input.name)),
    target: input.target,
    scope: input.scope,
    trigger: input.trigger,
    skills: input.skills,
    enabled: false,
    createdAt: now,
    updatedAt: now,
  }
  state.bundles.push(bundle)
  write(state)
  return bundle
}

export function updateBundle(id: string, input: BundleInput): Bundle {
  const state = read()
  const idx = state.bundles.findIndex(b => b.id === id)
  if (idx === -1) throw new Error(`Bundle ${id} not found`)
  assertNameUnique(state, input, id)
  const prev = state.bundles[idx]
  const renamed = prev.name !== input.name
  const next: Bundle = {
    ...prev,
    name: input.name,
    slug: renamed ? uniqueSlug(state, slugify(input.name), id) : prev.slug,
    target: input.target,
    scope: input.scope,
    trigger: input.trigger,
    skills: input.skills,
    updatedAt: new Date().toISOString(),
  }
  state.bundles[idx] = next
  write(state)
  return next
}

export function setEnabled(id: string, enabled: boolean): Bundle {
  const state = read()
  const idx = state.bundles.findIndex(b => b.id === id)
  if (idx === -1) throw new Error(`Bundle ${id} not found`)
  state.bundles[idx] = {
    ...state.bundles[idx],
    enabled,
    updatedAt: new Date().toISOString(),
  }
  write(state)
  return state.bundles[idx]
}

export function deleteBundle(id: string): Bundle | undefined {
  const state = read()
  const idx = state.bundles.findIndex(b => b.id === id)
  if (idx === -1) return undefined
  const [removed] = state.bundles.splice(idx, 1)
  write(state)
  return removed
}

export const __test = { storeFile }

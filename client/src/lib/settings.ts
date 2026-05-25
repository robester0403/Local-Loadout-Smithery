// User-tunable settings for the inventory table.
//
// Three concerns live here, all persisted to localStorage and shared across
// the Claude Code and Cursor tabs:
//
//   1. Column visibility — which columns the inventory table renders.
//   2. Flags — per-identifier on/off for each health state and diagnostic
//      badge. Turning a flag off propagates: the badge hides, filter logic
//      ignores it, the review banner stops counting it, and sort treats it
//      as no-flag. The skill itself stays in inventory.
//   3. Thresholds — the cost/dormant/bloat cutoffs that classifyInsight
//      consults via mergeWithCost / reapplyThresholds.
//
// The schema is a zod source-of-truth: parse() doubles as validator and
// migrator. The form layer (SettingsModal) uses `settingsSchema` directly
// via @hookform/resolvers/zod so cross-field rules introduced later only
// need to be added to the schema once.
//
// Persistence is versioned. When the schema changes, bump SETTINGS_VERSION
// and extend `migrate()` — never silently break user preferences and never
// throw on corrupt payloads (a localStorage error must degrade to defaults,
// not break the app).

import { z } from 'zod'
import { DEFAULT_THRESHOLDS } from './cost'

const STORAGE_KEY = 'loadoutsmith-settings'
const SETTINGS_VERSION = 3

/** Every column the inventory table can render. Source of truth for ordering
 *  + label is the table itself; this enum just enumerates the toggle surface. */
export const COLUMN_KEYS = [
  'health',
  'insight',
  'name',
  'type',
  'scope',
  'lastModified',
  'activeTokens',
  'loadedTokens',
  'invocations',
  'enabled',
] as const
export type ColumnKey = typeof COLUMN_KEYS[number]

export const COLUMN_LABELS: Record<ColumnKey, string> = {
  health: 'Health',
  insight: 'Diagnostics',
  name: 'Name',
  type: 'Type',
  scope: 'Context',
  lastModified: 'Modified',
  activeTokens: 'Active tokens',
  loadedTokens: 'Loaded tokens',
  invocations: 'Invocations',
  enabled: 'Enabled',
}

/** v2→v3: cost columns were renamed from `*Dollars` to a token/invocation
 *  view. Preserve the user's prior on/off choice when migrating. */
const LEGACY_COLUMN_RENAME: Record<string, ColumnKey> = {
  activeDollars: 'activeTokens',
  loadedDollars: 'loadedTokens',
  totalDollars: 'invocations',
}

export const FLAG_KEYS = [
  'healthOk',
  'healthWarn',
  'healthError',
  'removal',
  'winner',
  'dormant',
  'bloat',
  'mismatch',
] as const
export type FlagKey = typeof FLAG_KEYS[number]

export const FLAG_LABELS: Record<FlagKey, string> = {
  healthOk: 'Healthy (✓)',
  healthWarn: 'Warn (⚠)',
  healthError: 'Error (✗)',
  removal: 'Removal candidate',
  winner: 'Winner',
  dormant: 'Dormant',
  bloat: 'Description bloat',
  mismatch: 'Possible misclassification',
}

/** Which threshold inputs each flag governs. Used by the modal to grey out
 *  numeric inputs when their owning flag is disabled — the value still
 *  persists, it just becomes inert until the flag is re-enabled. */
export const FLAG_GOVERNS: Partial<Record<FlagKey, ('loadedHighUsd' | 'activeHighUsd' | 'dormantDays' | 'gracePeriodDays' | 'descBloatChars')[]>> = {
  removal: ['loadedHighUsd', 'activeHighUsd', 'gracePeriodDays'],
  winner: ['loadedHighUsd', 'activeHighUsd'],
  dormant: ['dormantDays'],
  bloat: ['descBloatChars'],
}

// ─── Zod schema (source of truth) ───────────────────────────────────────────

const columnsSchema = z.object(
  COLUMN_KEYS.reduce((acc, key) => {
    acc[key] = z.boolean()
    return acc
  }, {} as Record<ColumnKey, z.ZodBoolean>),
)

const flagsSchema = z.object(
  FLAG_KEYS.reduce((acc, key) => {
    acc[key] = z.boolean()
    return acc
  }, {} as Record<FlagKey, z.ZodBoolean>),
)

const thresholdsSchema = z.object({
  loadedHighUsd: z.number().finite().min(0),
  activeHighUsd: z.number().finite().min(0),
  dormantDays: z.number().finite().min(0),
  gracePeriodDays: z.number().finite().min(0),
  descBloatChars: z.number().finite().int().min(0),
})

export const settingsSchema = z.object({
  columns: columnsSchema,
  flags: flagsSchema,
  thresholds: thresholdsSchema,
})

export type Settings = z.infer<typeof settingsSchema>
export type Columns = z.infer<typeof columnsSchema>
export type Flags = z.infer<typeof flagsSchema>
export type Thresholds = z.infer<typeof thresholdsSchema>

// ─── Defaults ───────────────────────────────────────────────────────────────

function defaultColumns(): Columns {
  return COLUMN_KEYS.reduce(
    (acc, key) => { acc[key] = true; return acc },
    {} as Columns,
  )
}

function defaultFlags(): Flags {
  return FLAG_KEYS.reduce(
    (acc, key) => { acc[key] = true; return acc },
    {} as Flags,
  )
}

export function defaultSettings(): Settings {
  return {
    columns: defaultColumns(),
    flags: defaultFlags(),
    thresholds: { ...DEFAULT_THRESHOLDS },
  }
}

// ─── Validation / migration ─────────────────────────────────────────────────

interface PersistedEnvelope {
  version: number
  data: unknown
}

/**
 * Coerce an arbitrary payload into a valid Settings object. Order of attempts:
 *
 *   1. Zod-parse the data slice straight — covers current-version payloads
 *      and any older payload that happens to be structurally compatible.
 *   2. If parsing fails, deep-merge into defaults so missing fields are
 *      filled in (this handles v1 payloads gaining the `flags` group).
 *   3. If even the merged shape doesn't parse, return defaults.
 *
 * This loose approach lets us evolve the schema without ever throwing in
 * front of the user — a corrupt or partial payload degrades, it doesn't fail.
 */
function migrate(envelope: PersistedEnvelope | unknown): Settings {
  const raw = (envelope && typeof envelope === 'object' && 'data' in envelope)
    ? (envelope as PersistedEnvelope).data
    : envelope

  const renamed = renameLegacyColumns(raw)

  const direct = settingsSchema.safeParse(renamed)
  if (direct.success) return direct.data

  const defaults = defaultSettings()
  const merged = deepMerge(defaults, renamed)
  const m = settingsSchema.safeParse(merged)
  return m.success ? m.data : defaults
}

/** Carry forward the user's column-visibility preferences when v2 keys
 *  (activeDollars / loadedDollars / totalDollars) are present in the
 *  persisted payload. Done before zod parse so the renamed keys validate
 *  against the current schema. */
function renameLegacyColumns(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw
  const cols = raw.columns
  if (!isPlainObject(cols)) return raw
  let touched = false
  const next: Record<string, unknown> = { ...cols }
  for (const [legacy, current] of Object.entries(LEGACY_COLUMN_RENAME)) {
    if (legacy in next) {
      // Only adopt the legacy value if the new key wasn't already set —
      // otherwise the explicit current-version setting wins.
      if (!(current in next)) next[current] = next[legacy]
      delete next[legacy]
      touched = true
    }
  }
  if (!touched) return raw
  return { ...raw, columns: next }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function deepMerge<T>(base: T, overlay: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return base
  const out = { ...base } as Record<string, unknown>
  for (const [k, v] of Object.entries(overlay)) {
    const bv = (base as Record<string, unknown>)[k]
    if (isPlainObject(bv) && isPlainObject(v)) {
      out[k] = deepMerge(bv, v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out as T
}

// ─── Persistence ────────────────────────────────────────────────────────────

let cache: Settings | null = null

export function loadSettings(): Settings {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    cache = raw ? migrate(JSON.parse(raw)) : defaultSettings()
  } catch {
    // Quota / parse / privacy-mode failures — never let storage break the app.
    cache = defaultSettings()
  }
  return cache
}

export function saveSettings(next: Settings): void {
  // Re-validate at the persistence boundary so even mis-typed callers can't
  // smuggle bad data into localStorage. parse() throws on failure — at this
  // point callers should have validated through RHF, so a throw is loud and
  // appropriate.
  const validated = settingsSchema.parse(next)
  cache = validated
  try {
    const envelope: PersistedEnvelope = { version: SETTINGS_VERSION, data: validated }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
  } catch {
    // Best-effort persistence; in-memory cache still reflects the update so
    // the current session works even if storage is full or blocked.
  }
  emit()
}

// ─── Pub/sub for cross-component sync ───────────────────────────────────────

type Listener = () => void
const listeners = new Set<Listener>()

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function emit() {
  for (const fn of listeners) fn()
}

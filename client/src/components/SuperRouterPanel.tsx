import { useEffect, useState } from 'react'
import type { Bundle, BundleTarget, DriftResult, DriftStatus, ToggleBundleResult } from '../api'
import {
  deleteBundleApi,
  fetchBundleDrift,
  fetchBundles,
  openBundleFileApi,
  toggleBundleApi,
} from '../api'

// Server-side validation errors (HTTP 422) carry a `details` array with
// field-level messages. Render those instead of the useless "Validation
// failed" message — LOC-87 Bug B.
interface ValidationErrorDetail {
  field: string
  message: string
  offendingSkillIds?: string[]
}

function formatBundleError(e: unknown): string {
  const err = e as Error & { details?: unknown }
  if (Array.isArray(err.details)) {
    const lines = (err.details as ValidationErrorDetail[])
      .filter(d => typeof d?.message === 'string')
      .map(d => `• ${d.field}: ${d.message}`)
    if (lines.length > 0) return `${err.message}\n${lines.join('\n')}`
  }
  return err.message
}
import type { Skill } from '../types'
import BundleEditorModal from './BundleEditorModal'
import { useConfirm } from './ConfirmDialog'

const DRIFT_LABEL: Record<Exclude<DriftStatus, 'ok'>, string> = {
  'file-missing': 'CLAUDE.md missing',
  'block-missing': 'Block removed externally',
  'markers-corrupted': 'Marker tags broken',
  'block-modified': 'Block edited externally',
  'map-modified': 'Map file edited externally',
}

// Per-target lookups so Codex bundles don't get mislabeled as MCP (badge) or
// as CLAUDE.md (open-file button). The badge classes reuse existing
// .type-{skill,subagent,command} CSS for color variety.
const TARGET_BADGE_CLASS: Record<BundleTarget, string> = {
  claude: 'skill',
  cursor: 'subagent',
  codex: 'command',
}
const TARGET_OPEN_LABEL: Record<BundleTarget, string> = {
  claude: 'CLAUDE.md',
  cursor: 'Cursor MD',
  codex: 'AGENTS.md',
}

interface Props {
  allSkills: Skill[]
  onClose: () => void
  onCountChange?: (n: number) => void
}

function scopeLabel(b: Bundle): string {
  if (b.scope.kind === 'global') return 'global'
  return `project: ${b.scope.path.split('/').slice(-2).join('/')}`
}

export default function SuperRouterPanel({ allSkills, onClose, onCountChange }: Props) {
  const confirm = useConfirm()
  const [bundles, setBundles] = useState<Bundle[]>([])
  const [drift, setDrift] = useState<Record<string, DriftResult>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Bundle | null>(null)
  /** LOC-87: positive notice from a successful Reapply that involved
   *  reconciliation — distinct from `error` because nothing failed. */
  const [notice, setNotice] = useState<string | null>(null)

  async function refreshDrift() {
    try {
      const results = await fetchBundleDrift()
      const map: Record<string, DriftResult> = {}
      for (const r of results) map[r.bundleId] = r
      setDrift(map)
    } catch {
      // Drift detection is best-effort UX sugar — don't block the panel
      // if the endpoint hiccups.
    }
  }

  async function load() {
    setLoading(true)
    try {
      const list = await fetchBundles()
      setBundles(list)
      onCountChange?.(list.length)
      await refreshDrift()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleToggle(b: Bundle, next: boolean) {
    setBusyId(b.id)
    setError(null)
    setNotice(null)
    // Optimistic flip; revert on failure.
    setBundles(prev => prev.map(x => x.id === b.id ? { ...x, enabled: next } : x))
    try {
      const result = await toggleBundleApi(b.id, next)
      setBundles(prev => prev.map(x => x.id === b.id ? result.bundle : x))
      surfaceReconciledNotice(result)
      await refreshDrift()
    } catch (e) {
      setBundles(prev => prev.map(x => x.id === b.id ? b : x))
      setError(formatBundleError(e))
    } finally {
      setBusyId(null)
    }
  }

  async function handleReapply(b: Bundle) {
    setBusyId(b.id)
    setError(null)
    setNotice(null)
    try {
      // Re-running toggle with enabled=true reconciles any stale skill IDs
      // (renames / moves / reclassifies / symlink swaps, LOC-87) and rewrites
      // both on-disk files from the canonical content.
      const result = await toggleBundleApi(b.id, true)
      setBundles(prev => prev.map(x => x.id === b.id ? result.bundle : x))
      surfaceReconciledNotice(result)
      await refreshDrift()
    } catch (e) {
      setError(formatBundleError(e))
    } finally {
      setBusyId(null)
    }
  }

  function surfaceReconciledNotice(result: ToggleBundleResult): void {
    const parts: string[] = []
    if (result.healed && result.healed.length > 0) {
      const names = result.healed.map(h => h.name).filter(Boolean).join(', ')
      parts.push(`Reconciled ${result.healed.length} skill${result.healed.length === 1 ? '' : 's'}${names ? `: ${names}` : ''}.`)
    }
    if (result.missing && result.missing.length > 0) {
      const names = result.missing.map(m => m.name || m.decodedPath).filter(Boolean).join(', ')
      parts.push(`${result.missing.length} skill${result.missing.length === 1 ? '' : 's'} no longer installed${names ? ` (${names})` : ''} — open the bundle to remove or restore.`)
    }
    if (result.ambiguous && result.ambiguous.length > 0) {
      const names = result.ambiguous.map(a => a.name || a.decodedPath).filter(Boolean).join(', ')
      parts.push(`${result.ambiguous.length} skill${result.ambiguous.length === 1 ? '' : 's'} ambiguous${names ? ` (${names})` : ''} — pick one in the bundle editor.`)
    }
    setNotice(parts.length > 0 ? parts.join(' ') : null)
  }

  async function handleOpen(b: Bundle, which: 'top' | 'map') {
    setError(null)
    try {
      await openBundleFileApi(b.id, which)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function handleDelete(b: Bundle) {
    const ok = await confirm({
      title: 'Delete bundle?',
      message: `Delete bundle "${b.name}"?`,
      ...(b.enabled ? { detail: 'This will also remove the injected CLAUDE.md block and map file.' } : {}),
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    setBusyId(b.id)
    try {
      await deleteBundleApi(b.id)
      const next = bundles.filter(x => x.id !== b.id)
      setBundles(next)
      onCountChange?.(next.length)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  function handleSaved(updated: Bundle) {
    setBundles(prev => {
      const idx = prev.findIndex(b => b.id === updated.id)
      if (idx === -1) return [...prev, updated]
      const next = [...prev]
      next[idx] = updated
      return next
    })
    setEditing(null)
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 840 }}>
        <div className="modal-header">
          <div>
            <div className="modal-title">SuperRouter bundles</div>
            <div className="modal-subtitle">
              Skills behind a trigger condition. Toggle a bundle on to inject the trigger block into CLAUDE.md; toggle off to remove it.
            </div>
          </div>
          <button className="btn btn-sm modal-close" onClick={onClose}>×</button>
        </div>

        {error && (
          <div className="form-error" style={{ marginBottom: 12, whiteSpace: 'pre-line' }}>
            {error}
          </div>
        )}
        {notice && !error && (
          <div
            style={{
              marginBottom: 12,
              padding: '8px 10px',
              border: '1px solid var(--c-success, #7DDED8)',
              background: 'var(--c-success-bg, rgba(125, 222, 216, .12))',
              color: 'var(--c-success, #7DDED8)',
              borderRadius: 4,
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            {notice}
          </div>
        )}

        {loading ? (
          <div className="empty-state" style={{ minHeight: 120 }}>
            <div className="spinner" />
          </div>
        ) : bundles.length === 0 ? (
          <div className="trash-empty">
            <div className="trash-empty-icon">🛣</div>
            <div className="trash-empty-title">No bundles yet</div>
            <div className="trash-empty-sub">
              Select skills in the inventory, then click <em>Create routing bundle</em>.
            </div>
          </div>
        ) : (
          <div className="trash-list">
            {bundles.map(b => {
              const d = drift[b.id]
              const isDrifted = b.enabled && d && d.status !== 'ok'
              return (
              <div key={b.id} className="trash-row" style={{ alignItems: 'flex-start' }}>
                <div className="trash-info">
                  <div className="trash-name-row">
                    <span className="trash-name">{b.name}</span>
                    <span className={`type-badge type-${TARGET_BADGE_CLASS[b.target]}`}>{b.target}</span>
                    <span className={`scope-badge scope-${b.scope.kind}`}>{scopeLabel(b)}</span>
                    <span style={{
                      fontSize: 11,
                      padding: '2px 6px',
                      borderRadius: 3,
                      background: b.enabled ? 'var(--c-success)' : 'var(--border)',
                      color: b.enabled ? '#1D1E24' : 'var(--text-dim)',
                    }}>
                      {b.enabled ? 'ON' : 'OFF'}
                    </span>
                    {b.enabled && d && (
                      isDrifted ? (
                        <span
                          title={d.details ?? DRIFT_LABEL[d.status as Exclude<DriftStatus, 'ok'>]}
                          style={{
                            fontSize: 11,
                            padding: '2px 6px',
                            borderRadius: 3,
                            background: 'var(--c-warn, #c89b3a)',
                            color: '#1D1E24',
                          }}
                        >
                          ⚠ {DRIFT_LABEL[d.status as Exclude<DriftStatus, 'ok'>]}
                        </span>
                      ) : (
                        <span
                          title="Bundle on disk matches expected state"
                          aria-label="in sync"
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: 'var(--c-success)',
                            display: 'inline-block',
                          }}
                        />
                      )
                    )}
                  </div>
                  <div className="trash-desc" style={{ marginTop: 4 }}>{b.trigger}</div>
                  <div className="trash-meta" style={{ marginTop: 4 }}>
                    {b.skills.length} skill{b.skills.length === 1 ? '' : 's'} ·{' '}
                    <code style={{ fontSize: 11 }}>{b.paths.topFile}</code>
                  </div>
                </div>
                <div className="trash-actions" style={{ flexDirection: 'column', gap: 4 }}>
                  {isDrifted && (
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={busyId === b.id}
                      onClick={() => handleReapply(b)}
                      title="Rewrite the trigger block and map file from the bundle's canonical state"
                    >Re-apply</button>
                  )}
                  <button
                    className={`btn btn-sm ${b.enabled ? 'btn-warn' : 'btn-primary'}`}
                    disabled={busyId === b.id}
                    onClick={() => handleToggle(b, !b.enabled)}
                  >
                    {busyId === b.id ? '…' : b.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => handleOpen(b, 'top')}
                    title={`Open ${b.paths.topFile} in your default editor`}
                  >Open {TARGET_OPEN_LABEL[b.target]}</button>
                  <button
                    className="btn btn-sm"
                    onClick={() => handleOpen(b, 'map')}
                    disabled={!b.enabled}
                    title={b.enabled ? `Open ${b.paths.mapFile}` : 'Map file only exists while the bundle is enabled'}
                  >Open map</button>
                  <button
                    className="btn btn-sm"
                    disabled={busyId === b.id}
                    onClick={() => setEditing(b)}
                  >Edit</button>
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={busyId === b.id}
                    onClick={() => handleDelete(b)}
                  >Delete</button>
                </div>
              </div>
              )
            })}
          </div>
        )}

        {editing && (
          <BundleEditorModal
            initial={editing}
            allSkills={allSkills}
            onClose={() => setEditing(null)}
            onSaved={handleSaved}
          />
        )}
      </div>
    </div>
  )
}

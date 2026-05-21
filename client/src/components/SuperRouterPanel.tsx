import { useEffect, useState } from 'react'
import type { Bundle, DriftResult, DriftStatus } from '../api'
import {
  deleteBundleApi,
  fetchBundleDrift,
  fetchBundles,
  openBundleFileApi,
  toggleBundleApi,
} from '../api'
import type { Skill } from '../types'
import BundleEditorModal from './BundleEditorModal'

const DRIFT_LABEL: Record<Exclude<DriftStatus, 'ok'>, string> = {
  'file-missing': 'CLAUDE.md missing',
  'block-missing': 'Block removed externally',
  'markers-corrupted': 'Marker tags broken',
  'block-modified': 'Block edited externally',
  'map-modified': 'Map file edited externally',
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
  const [bundles, setBundles] = useState<Bundle[]>([])
  const [drift, setDrift] = useState<Record<string, DriftResult>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Bundle | null>(null)

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
    // Optimistic flip; revert on failure.
    setBundles(prev => prev.map(x => x.id === b.id ? { ...x, enabled: next } : x))
    try {
      const updated = await toggleBundleApi(b.id, next)
      setBundles(prev => prev.map(x => x.id === b.id ? updated : x))
      await refreshDrift()
    } catch (e) {
      setBundles(prev => prev.map(x => x.id === b.id ? b : x))
      setError((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  async function handleReapply(b: Bundle) {
    setBusyId(b.id)
    setError(null)
    try {
      // Re-running toggle with enabled=true rewrites both files from canonical
      // content, which is exactly what we want.
      const updated = await toggleBundleApi(b.id, true)
      setBundles(prev => prev.map(x => x.id === b.id ? updated : x))
      await refreshDrift()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusyId(null)
    }
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
    if (!window.confirm(`Delete bundle "${b.name}"? ${b.enabled ? 'This will also remove the injected CLAUDE.md block and map file.' : ''}`)) return
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

        {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}

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
                    <span className={`type-badge type-${b.target === 'claude' ? 'skill' : 'subagent'}`}>{b.target}</span>
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
                  >Open {b.target === 'cursor' ? 'Cursor MD' : 'CLAUDE.md'}</button>
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

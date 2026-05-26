import { useState, useEffect } from 'react'
import type { UninstalledEntry } from '../api'
import { fetchUninstalled, restoreSkillApi, permanentDeleteApi } from '../api'
import { useConfirm } from './ConfirmDialog'

interface Props {
  onClose: () => void
  onRestored: () => void
  onCountChange: (n: number) => void
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export default function UninstalledPanel({ onClose, onRestored, onCountChange }: Props) {
  const confirm = useConfirm()
  const [entries, setEntries] = useState<UninstalledEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const list = await fetchUninstalled()
      setEntries(list)
      onCountChange(list.length)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleRestore(entry: UninstalledEntry) {
    setWorking(entry.id)
    try {
      await restoreSkillApi(entry.id)
      const next = entries.filter(e => e.id !== entry.id)
      setEntries(next)
      onCountChange(next.length)
      onRestored()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setWorking(null)
    }
  }

  async function handleDelete(entry: UninstalledEntry) {
    const ok = await confirm({
      title: 'Delete permanently?',
      message: `Permanently delete "${entry.name}"?`,
      detail: 'This cannot be undone.',
      confirmLabel: 'Delete forever',
      destructive: true,
    })
    if (!ok) return
    setWorking(entry.id)
    try {
      await permanentDeleteApi(entry.id)
      const next = entries.filter(e => e.id !== entry.id)
      setEntries(next)
      onCountChange(next.length)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setWorking(null)
    }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal trash-modal">
        <div className="modal-header">
          <div>
            <div className="modal-title">Trash</div>
            <div className="modal-subtitle">Uninstalled skills — restore or permanently delete</div>
          </div>
          <button className="btn btn-sm modal-close" onClick={onClose}>×</button>
        </div>

        {error && (
          <div className="form-error" style={{ marginBottom: 16 }}>{error}</div>
        )}

        {loading ? (
          <div className="empty-state" style={{ minHeight: 120 }}>
            <div className="spinner" />
          </div>
        ) : entries.length === 0 ? (
          <div className="trash-empty">
            <div className="trash-empty-icon">🗑</div>
            <div className="trash-empty-title">Trash is empty</div>
            <div className="trash-empty-sub">Uninstalled skills will appear here until permanently deleted.</div>
          </div>
        ) : (
          <div className="trash-list">
            {entries.map(entry => (
              <div key={entry.id} className="trash-row">
                <div className="trash-info">
                  <div className="trash-name-row">
                    <span className="trash-name">{entry.name}</span>
                    <span className={`type-badge type-${entry.type}`}>{entry.type}</span>
                    <span className={`scope-badge scope-${entry.scope}`}>{entry.scope}</span>
                  </div>
                  <div className="trash-desc">{entry.description}</div>
                  <div className="trash-meta">
                    Uninstalled {formatDate(entry.uninstalledAt)} · {entry.account}
                  </div>
                </div>
                <div className="trash-actions">
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => handleRestore(entry)}
                    disabled={working === entry.id}
                  >
                    {working === entry.id ? '…' : 'Restore'}
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => handleDelete(entry)}
                    disabled={working === entry.id}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

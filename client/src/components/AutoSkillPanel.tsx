import { useEffect, useMemo, useState } from 'react'
import type { Candidate, CandidateStatus, OllamaModel } from '../api'
import {
  deleteCandidate,
  fetchCandidates,
  fetchOllamaModels,
  fetchSettings,
  patchSettings,
  rejectCandidate,
  runDigestApi,
  runExtractApi,
} from '../api'
import type { Skill } from '../types'
import AcceptCandidateModal from './AcceptCandidateModal'
import CompareCandidateModal from './CompareCandidateModal'

interface Props {
  allSkills: Skill[]
  onClose: () => void
  onSkillsChanged: () => void
}

const LOOKBACK_OPTIONS = [
  { value: 7, label: '1 week' },
  { value: 14, label: '2 weeks (default)' },
  { value: 30, label: '1 month' },
  { value: 90, label: '3 months' },
]

function fmtScore(s: number): string {
  return `${Math.round(s * 100)}%`
}

export default function AutoSkillPanel({ allSkills, onClose, onSkillsChanged }: Props) {
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [statusFilter, setStatusFilter] = useState<CandidateStatus | 'all-active'>('all-active')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [ollamaAvailable, setOllamaAvailable] = useState<boolean | null>(null)
  const [models, setModels] = useState<OllamaModel[]>([])
  const [model, setModel] = useState('')
  const [lookback, setLookback] = useState(14)

  const [running, setRunning] = useState<'idle' | 'extracting' | 'digesting'>('idle')
  const [runMessage, setRunMessage] = useState('')

  const [accepting, setAccepting] = useState<Candidate | null>(null)
  const [comparing, setComparing] = useState<Candidate | null>(null)

  async function refreshCandidates() {
    try {
      setCandidates(await fetchCandidates())
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    (async () => {
      setLoading(true)
      try {
        const [list, settings, modelInfo] = await Promise.all([
          fetchCandidates(),
          fetchSettings(),
          fetchOllamaModels(),
        ])
        setCandidates(list)
        setOllamaAvailable(modelInfo.available)
        setModels(modelInfo.models)
        setModel(settings.autoSkill.model || modelInfo.models[0]?.name || '')
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  async function handleRun() {
    if (!model) { setError('Pick a model first.'); return }
    setError(null)
    try {
      setRunning('extracting')
      setRunMessage('Extracting conversations…')
      const extract = await runExtractApi({ lookbackDays: lookback })
      const totalAdded = extract.results.reduce((sum, r) => sum + r.added, 0)
      setRunMessage(`Extracted ${totalAdded} new conversations. Saving model choice…`)
      await patchSettings({ autoSkill: { model } })
      setRunning('digesting')
      setRunMessage(`Digesting with ${model}…`)
      const digest = await runDigestApi({ lookbackDays: lookback, model, purgeRawOnSuccess: true })
      setRunMessage(`Done. ${digest.candidatesCreated} new, ${digest.candidatesUpdated} updated. ${digest.warnings.length} warnings.`)
      await refreshCandidates()
    } catch (e) {
      setError((e as Error).message)
      setRunMessage('')
    } finally {
      setRunning('idle')
    }
  }

  async function handleReject(c: Candidate) {
    setBusy(c.id)
    try {
      await rejectCandidate(c.id)
      await refreshCandidates()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function handleDelete(c: Candidate) {
    if (!window.confirm(`Permanently delete candidate "${c.name}"?`)) return
    setBusy(c.id)
    try {
      await deleteCandidate(c.id)
      await refreshCandidates()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const filtered = useMemo(() => {
    if (statusFilter === 'all-active') return candidates.filter(c => c.status !== 'rejected')
    return candidates.filter(c => c.status === statusFilter)
  }, [candidates, statusFilter])

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 980 }}>
        <div className="modal-header">
          <div>
            <div className="modal-title">Auto Skill</div>
            <div className="modal-subtitle">
              Find candidate skills hidden in your chat history. Conversations are extracted, digested with a local model, then deleted — only the candidates and short excerpts persist.
            </div>
          </div>
          <button className="btn btn-sm modal-close" onClick={onClose}>×</button>
        </div>

        {ollamaAvailable === false && (
          <div className="form-error" style={{ marginBottom: 12 }}>
            <strong>Ollama not detected.</strong> Install Ollama and pull a model, e.g.:
            <pre style={{ marginTop: 6, fontSize: 11 }}>brew install ollama
ollama serve &
ollama pull qwen2.5:7b</pre>
            Then reopen this panel.
          </div>
        )}

        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ minWidth: 200 }}>
            <label className="form-label">Model</label>
            <select className="form-input" value={model} onChange={e => setModel(e.target.value)} disabled={!ollamaAvailable}>
              {models.length === 0 && <option value="">(no models installed)</option>}
              {models.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
            </select>
          </div>
          <div>
            <label className="form-label">Lookback</label>
            <select className="form-input" value={lookback} onChange={e => setLookback(Number(e.target.value))}>
              {LOOKBACK_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleRun}
            disabled={!ollamaAvailable || running !== 'idle' || !model}
          >
            {running === 'idle' ? 'Run digest' : runMessage || 'Working…'}
          </button>
          <div style={{ marginLeft: 'auto' }}>
            <label className="form-label">Filter</label>
            <select className="form-input" value={statusFilter} onChange={e => setStatusFilter(e.target.value as CandidateStatus | 'all-active')}>
              <option value="all-active">Pending + accepted</option>
              <option value="pending">Pending only</option>
              <option value="accepted">Accepted</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>
        </div>

        {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}
        {runMessage && running === 'idle' && (
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>{runMessage}</div>
        )}

        {loading ? (
          <div className="empty-state" style={{ minHeight: 120 }}><div className="spinner" /></div>
        ) : filtered.length === 0 ? (
          <div className="trash-empty">
            <div className="trash-empty-icon">🌾</div>
            <div className="trash-empty-title">No candidates {statusFilter !== 'all-active' ? `in "${statusFilter}"` : 'yet'}</div>
            <div className="trash-empty-sub">Click "Run digest" to scan your recent conversations.</div>
          </div>
        ) : (
          <div className="trash-list">
            {filtered.map(c => (
              <div key={c.id} className="trash-row" style={{ alignItems: 'flex-start' }}>
                <div className="trash-info">
                  <div className="trash-name-row">
                    <span className="trash-name">{c.name}</span>
                    <span className={`type-badge type-${c.suggestedType}`}>{c.suggestedType}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>score {fmtScore(c.score)}</span>
                    <span style={{
                      fontSize: 11, padding: '2px 6px', borderRadius: 3,
                      background:
                        c.status === 'accepted' ? 'var(--c-success)'
                        : c.status === 'rejected' ? 'var(--border)'
                        : 'var(--c-warning)',
                      color: c.status === 'rejected' ? 'var(--text-dim)' : '#1D1E24',
                    }}>{c.status}</span>
                    {c.existingMatch && (
                      <span
                        title={`Looks similar to "${c.existingMatch.skillName}" (${c.existingMatch.matchKind} similarity ${Math.round(c.existingMatch.similarity * 100)}%)`}
                        style={{
                          fontSize: 11, padding: '2px 6px', borderRadius: 3,
                          background: 'var(--accent-dim)', color: 'var(--accent)',
                        }}
                      >🔁 already in loadout</span>
                    )}
                  </div>
                  <div className="trash-desc" style={{ marginTop: 4 }}>{c.description}</div>
                  <div className="trash-meta" style={{ marginTop: 4 }}>
                    {c.sourceRefs.length} conversation{c.sourceRefs.length === 1 ? '' : 's'} · model {c.model}
                    {c.acceptedPath && <> · <code style={{ fontSize: 11 }}>{c.acceptedPath}</code></>}
                  </div>
                  {c.sourceRefs.slice(0, 3).map(r => (
                    <div key={r.conversationId} style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                      <span className={`scope-badge scope-${r.source === 'cursor' ? 'project' : 'global'}`}>{r.source}</span>{' '}
                      <em>{r.excerpt}</em>
                    </div>
                  ))}
                </div>
                <div className="trash-actions" style={{ flexDirection: 'column', gap: 4 }}>
                  {c.status === 'pending' && (
                    <button className="btn btn-sm btn-primary" disabled={busy === c.id} onClick={() => setAccepting(c)}>
                      Accept
                    </button>
                  )}
                  {c.existingMatch && (
                    <button className="btn btn-sm" onClick={() => setComparing(c)} title="Ask the local model what this candidate adds over the existing skill">
                      Compare
                    </button>
                  )}
                  {c.status === 'pending' && (
                    <button className="btn btn-sm" disabled={busy === c.id} onClick={() => handleReject(c)}>Reject</button>
                  )}
                  <button className="btn btn-sm btn-danger" disabled={busy === c.id} onClick={() => handleDelete(c)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {accepting && (
          <AcceptCandidateModal
            candidate={accepting}
            allSkills={allSkills}
            onClose={() => setAccepting(null)}
            onAccepted={async (_path, _updated) => {
              setAccepting(null)
              await refreshCandidates()
              onSkillsChanged()
            }}
          />
        )}

        {comparing && (
          <CompareCandidateModal
            candidate={comparing}
            onClose={() => setComparing(null)}
            onUpdated={updated => {
              setComparing(updated)
              setCandidates(prev => prev.map(c => c.id === updated.id ? updated : c))
            }}
          />
        )}
      </div>
    </div>
  )
}

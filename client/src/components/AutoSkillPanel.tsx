import { useEffect, useMemo, useRef, useState } from 'react'
import type { Candidate, CandidateStatus, DigestProgress, OllamaModel } from '../api'
import {
  clearCandidates,
  deleteCandidate,
  fetchCandidates,
  fetchDigestProgress,
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
  const [digestProgress, setDigestProgress] = useState<DigestProgress | null>(null)
  const [forceReextract, setForceReextract] = useState(false)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

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
        const [list, settings, modelInfo, progress] = await Promise.all([
          fetchCandidates(),
          fetchSettings(),
          fetchOllamaModels(),
          fetchDigestProgress().catch(() => null),
        ])
        setCandidates(list)
        setOllamaAvailable(modelInfo.available)
        setModels(modelInfo.models)
        setModel(settings.autoSkill.model || modelInfo.models[0]?.name || '')
        // LOC-90: if a digest is still running server-side from a prior
        // mount of this modal, pick it up rather than dropping the user
        // into a blank panel. Non-terminal phases re-attach polling;
        // terminal phases (done/error) just render the bar's final state
        // briefly so the user sees confirmation.
        if (progress && progress.phase !== 'idle') {
          setDigestProgress(progress)
          if (progress.phase !== 'done' && progress.phase !== 'error') {
            setRunning('digesting')
            setRunMessage(progress.message || 'Digesting…')
            startPolling()
          }
        }
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // LOC-90: when polling sees the digest hit a terminal phase from a
  // re-attached panel (i.e. the user opened the modal mid-run rather
  // than starting it here), finalize cleanly: stop polling, refresh
  // candidates, surface the result message. Guarded by `running` so we
  // only fire the finalization once per re-attach session.
  useEffect(() => {
    if (!digestProgress) return
    if (running !== 'digesting') return
    if (digestProgress.phase !== 'done' && digestProgress.phase !== 'error') return
    stopPolling()
    setRunning('idle')
    if (digestProgress.phase === 'done') {
      setRunMessage(digestProgress.message || 'Done.')
      void refreshCandidates()
    } else {
      setRunMessage('')
      setError(digestProgress.error || 'Digest failed.')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digestProgress, running])

  // LOC-90: terminal-state bar auto-hides after 3s so a successful re-attach
  // (or a normal run finish) doesn't leave a stale 100% bar pinned in the UI
  // forever. Only fires when the panel is in idle state and the progress is
  // terminal — an in-flight progress is left alone.
  useEffect(() => {
    if (!digestProgress) return
    if (running !== 'idle') return
    if (digestProgress.phase !== 'done' && digestProgress.phase !== 'error') return
    const t = setTimeout(() => setDigestProgress(null), 3000)
    return () => clearTimeout(t)
  }, [digestProgress, running])

  // Poll the server-side digest progress every 1.5 s while a digest is in
  // flight. The status endpoint is cheap (in-memory read) so this is fine.
  function startPolling() {
    stopPolling()
    pollTimerRef.current = setInterval(async () => {
      try {
        setDigestProgress(await fetchDigestProgress())
      } catch { /* server bouncing — try again next tick */ }
    }, 1500)
  }
  function stopPolling() {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }
  useEffect(() => () => stopPolling(), [])

  async function handleRun() {
    if (!model) { setError('Pick a model first.'); return }
    setError(null)
    try {
      setRunning('extracting')
      setRunMessage(forceReextract
        ? `Re-extracting last ${lookback} days from source…`
        : 'Extracting conversations…')
      const extract = await runExtractApi({ lookbackDays: lookback, forceReextract })
      const totalAdded = extract.results.reduce((sum, r) => sum + r.added, 0)
      setRunMessage(`Extracted ${totalAdded} ${forceReextract ? 'conversations (force-re-extract)' : 'new conversations'}. Saving model choice…`)
      // forceReextract is a one-shot — auto-clear after the run so the next
      // digest doesn't accidentally re-pull the same window.
      if (forceReextract) setForceReextract(false)
      await patchSettings({ autoSkill: { model } })
      setRunning('digesting')
      setRunMessage(`Digesting with ${model}…`)
      startPolling()
      const digest = await runDigestApi({ lookbackDays: lookback, model, purgeRawOnSuccess: true })
      stopPolling()
      // Final snapshot so the bar shows 100% before vanishing.
      try { setDigestProgress(await fetchDigestProgress()) } catch { /* ignore */ }
      setRunMessage(`Done. ${digest.candidatesCreated} new, ${digest.candidatesUpdated} updated. ${digest.warnings.length} warnings.`)
      await refreshCandidates()
    } catch (e) {
      stopPolling()
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

  function handleExport() {
    const countByStatus = candidates.reduce<Record<string, number>>((acc, c) => {
      acc[c.status] = (acc[c.status] ?? 0) + 1
      return acc
    }, {})
    const countByType = candidates.reduce<Record<string, number>>((acc, c) => {
      acc[c.suggestedType] = (acc[c.suggestedType] ?? 0) + 1
      return acc
    }, {})
    const exportedAt = new Date().toISOString()
    const payload = {
      exportedAt,
      totalCount: candidates.length,
      countByStatus,
      countByType,
      candidates,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `candidates-export-${exportedAt.replace(/[:.]/g, '-')}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
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

  // Bulk-clear all pending candidates. Accepted ones are server-side
  // protected (they carry an acceptedPath back-pointer to a real installed
  // file). Useful when accumulated cruft from many digest runs makes the
  // panel hard to read; the next digest re-surfaces any still-recurring
  // patterns from real conversation data.
  async function handleClearPending() {
    const pendingCount = candidates.filter(c => c.status === 'pending').length
    if (pendingCount === 0) return
    if (!window.confirm(`Permanently delete all ${pendingCount} pending candidate${pendingCount === 1 ? '' : 's'}? Accepted skills are not affected. The next digest will re-surface any patterns still recurring in your conversation history.`)) return
    setBusy('__clear_pending__')
    try {
      await clearCandidates('pending')
      await refreshCandidates()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const filtered = useMemo(() => {
    const base = statusFilter === 'all-active'
      ? candidates.filter(c => c.status !== 'rejected')
      : candidates.filter(c => c.status === statusFilter)
    return [...base].sort((a, b) => b.score - a.score)
  }, [candidates, statusFilter])

  // Group filtered candidates by suggestedType for the new pipeline's
  // type-segregated rendering (LOC-78). Order matches the four-artifact
  // taxonomy from docs/signal-detection-pipeline.md.
  const grouped = useMemo(() => {
    const kinds: Array<{ kind: Candidate['suggestedType']; label: string }> = [
      { kind: 'skill',    label: 'Skills' },
      { kind: 'command',  label: 'Commands' },
      { kind: 'subagent', label: 'Subagents' },
      { kind: 'rule',     label: 'CLAUDE.md / AGENTS.md Rules' },
    ]
    return kinds
      .map(k => ({ ...k, items: filtered.filter(c => c.suggestedType === k.kind) }))
      .filter(g => g.items.length > 0)
  }, [filtered])

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
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-dim)', cursor: 'pointer', paddingBottom: 8 }}
            title="One-shot: ignore the extraction high-water mark and re-pull conversations within the lookback window even if they've been extracted before. Useful for re-discovering previously-cleared candidates. Auto-clears after the run."
          >
            <input
              type="checkbox"
              checked={forceReextract}
              onChange={e => setForceReextract(e.target.checked)}
              disabled={running !== 'idle'}
            />
            Force re-extract
          </label>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleRun}
            disabled={!ollamaAvailable || running !== 'idle' || !model}
          >
            {running === 'idle' ? 'Run digest' : runMessage || 'Working…'}
          </button>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div>
              <label className="form-label">Filter</label>
              <select className="form-input" value={statusFilter} onChange={e => setStatusFilter(e.target.value as CandidateStatus | 'all-active')}>
                <option value="all-active">Pending + accepted</option>
                <option value="pending">Pending only</option>
                <option value="accepted">Accepted</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>
            <button
              className="btn btn-sm"
              onClick={handleExport}
              disabled={loading || candidates.length === 0}
              title="Download all candidates as JSON. Exports the full set regardless of the Filter dropdown — useful for diffing pipeline output before/after a change."
            >
              Export JSON
            </button>
            {(() => {
              const pendingCount = candidates.filter(c => c.status === 'pending').length
              return (
                <button
                  className="btn btn-sm btn-danger"
                  disabled={pendingCount === 0 || busy === '__clear_pending__'}
                  onClick={handleClearPending}
                  title="Permanently delete all pending candidates. Accepted skills are not affected. The next digest will re-surface any patterns still recurring in your conversations."
                >
                  {busy === '__clear_pending__' ? 'Clearing…' : `Clear ${pendingCount} pending`}
                </button>
              )
            })()}
          </div>
        </div>

        {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}
        {runMessage && running === 'idle' && !digestProgress && (
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>{runMessage}</div>
        )}

        {digestProgress && digestProgress.phase !== 'idle' && (() => {
          const total = digestProgress.total
          const completed = digestProgress.completed
          const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0
          const indeterminate = total === 0 || digestProgress.phase === 'starting' || digestProgress.phase === 'finalizing'
          const isError = digestProgress.phase === 'error'
          const isDone = digestProgress.phase === 'done'
          // Auto-hide the bar a couple of seconds after a successful run.
          return (
            <div style={{ marginBottom: 12 }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                fontSize: 11, color: 'var(--text-dim)', marginBottom: 4,
              }}>
                <span>{digestProgress.message || digestProgress.phase}</span>
                <span>{total > 0 ? `${completed}/${total} chunks` : isDone ? '' : '…'}</span>
              </div>
              <div style={{
                height: 6, borderRadius: 3, background: 'var(--border)',
                overflow: 'hidden', position: 'relative',
              }}>
                <div style={{
                  height: '100%',
                  width: indeterminate ? '35%' : `${pct}%`,
                  background: isError ? 'var(--c-danger)' : isDone ? 'var(--c-success)' : 'var(--accent)',
                  transition: 'width 300ms ease',
                  animation: indeterminate ? 'progressIndeterminate 1.4s ease-in-out infinite' : undefined,
                  position: 'relative',
                }} />
              </div>
              {isError && digestProgress.error && (
                <div style={{ fontSize: 11, color: 'var(--c-danger)', marginTop: 4 }}>{digestProgress.error}</div>
              )}
            </div>
          )
        })()}

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
            {grouped.map(group => (
              <div key={group.kind}>
                <div style={{
                  fontSize: 12, fontWeight: 600, color: 'var(--text-dim)',
                  textTransform: 'uppercase', letterSpacing: 0.5,
                  margin: '14px 0 6px 0',
                }}>
                  {group.label} <span style={{ opacity: 0.6, fontWeight: 400 }}>({group.items.length})</span>
                </div>
                {group.items.map(c => (
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
                        {c.existingMatch && (() => {
                          // Fall back to candidate's own type for older
                          // payloads that pre-date the cross-type kind field.
                          const matchedKind = c.existingMatch.kind ?? c.suggestedType
                          const crossType = matchedKind !== c.suggestedType
                          return (
                            <span
                              title={`Refines existing ${matchedKind} "${c.existingMatch.skillName}" (similarity ${Math.round(c.existingMatch.similarity * 100)}%)${crossType ? ` — this ${c.suggestedType} candidate looks like an existing ${matchedKind}` : ''}`}
                              style={{
                                fontSize: 11, padding: '2px 6px', borderRadius: 3,
                                background: 'var(--accent-dim)', color: 'var(--accent)',
                              }}
                            >🔁 refines {crossType ? `${matchedKind} ` : ''}{c.existingMatch.skillName}</span>
                          )
                        })()}
                      </div>
                      <div className="trash-desc" style={{ marginTop: 4 }}>{c.description}</div>
                      {c.reasonForUser && (
                        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, fontStyle: 'italic' }}>
                          <span style={{ fontWeight: 600 }}>Why we proposed this:</span> {c.reasonForUser}
                        </div>
                      )}
                      <div className="trash-meta" style={{ marginTop: 4 }}>
                        {c.sourceRefs.length} conversation{c.sourceRefs.length === 1 ? '' : 's'} · model {c.model}
                        {c.suggestedType === 'rule' && !c.acceptedPath && (
                          <> · <em>will append to {c.suggestedSection ? `## ${c.suggestedSection}` : 'Conventions'} in CLAUDE.md / AGENTS.md</em></>
                        )}
                        {c.acceptedPath && <> · <code style={{ fontSize: 11 }}>{c.acceptedPath}</code></>}
                      </div>
                      {c.sourceRefs.slice(0, 3).map(r => (
                        <div key={r.conversationId} style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                          <span className={`scope-badge scope-${r.source === 'cursor' ? 'project' : 'global'}`}>{r.source}</span>{' '}
                          <em>{r.excerpt}</em>
                        </div>
                      ))}
                      {c.evidenceQuotes && c.evidenceQuotes.length > 0 && (
                        <details style={{ marginTop: 6 }}>
                          <summary style={{ fontSize: 11, color: 'var(--text-dim)', cursor: 'pointer' }}>
                            {c.evidenceQuotes.length} evidence quote{c.evidenceQuotes.length === 1 ? '' : 's'}
                          </summary>
                          <div style={{ marginTop: 4, paddingLeft: 12 }}>
                            {c.evidenceQuotes.slice(0, 5).map((q, i) => (
                              <div key={i} style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                                <em>"{q.quote}"</em>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
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
            ))}
          </div>
        )}

        {accepting && (
          <AcceptCandidateModal
            candidate={accepting}
            allSkills={allSkills}
            onClose={() => setAccepting(null)}
            onAccepted={async () => {
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

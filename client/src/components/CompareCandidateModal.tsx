import { useState } from 'react'
import type { Candidate, ImprovementSuggestion } from '../api'
import { compareCandidateApi } from '../api'

interface Props {
  candidate: Candidate
  onClose: () => void
  onUpdated: (next: Candidate) => void
}

function suggestionColor(kind: ImprovementSuggestion['kind']): string {
  if (kind === 'no-improvement') return 'var(--text-dim)'
  return 'var(--c-warning)'
}

function suggestionBadge(kind: ImprovementSuggestion['kind']): string {
  switch (kind) {
    case 'add-to-description': return 'description'
    case 'add-to-body': return 'body'
    case 'no-improvement': return 'no change'
  }
}

export default function CompareCandidateModal({ candidate, onClose, onUpdated }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const match = candidate.existingMatch
  const notes = candidate.improvementNotes

  async function runCompare(force = false) {
    setBusy(true)
    setError(null)
    try {
      const result = await compareCandidateApi(candidate.id, { force })
      onUpdated(result.candidate)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 900 }}>
        <div className="modal-header">
          <div>
            <div className="modal-title">Compare against existing skill</div>
            <div className="modal-subtitle">
              {match
                ? <>Matches <strong>{match.skillName}</strong> ({match.matchKind} similarity {Math.round(match.similarity * 100)}%)</>
                : <>No existing match found.</>}
            </div>
          </div>
          <button className="btn btn-sm modal-close" onClick={onClose}>×</button>
        </div>

        {!match ? (
          <div className="trash-empty">
            <div className="trash-empty-title">This candidate is not flagged as a duplicate.</div>
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div>
                <label className="form-label">Existing skill</label>
                <div style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)', fontSize: 12 }}>
                  <div><strong>{match.skillName}</strong></div>
                  <div style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 4, wordBreak: 'break-all' }}>{match.skillPath}</div>
                </div>
              </div>
              <div>
                <label className="form-label">Candidate</label>
                <div style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)', fontSize: 12 }}>
                  <div><strong>{candidate.name}</strong> <span className={`type-badge type-${candidate.suggestedType}`}>{candidate.suggestedType}</span></div>
                  <div style={{ color: 'var(--text-dim)', marginTop: 4 }}>{candidate.description}</div>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
              <label className="form-label" style={{ margin: 0 }}>Improvement suggestions</label>
              {notes && (
                <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                  compared {new Date(notes.comparedAt).toLocaleString()} with {notes.model}
                </span>
              )}
              <button
                className="btn btn-sm"
                style={{ marginLeft: 'auto' }}
                onClick={() => runCompare(!!notes)}
                disabled={busy}
              >
                {busy ? 'Comparing…' : notes ? 'Re-compare' : 'Compare with local model'}
              </button>
            </div>

            {error && <div className="form-error">{error}</div>}

            {!notes && !busy && (
              <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: 12, border: '1px dashed var(--border)', borderRadius: 6 }}>
                Click <strong>Compare with local model</strong> to ask Ollama what the candidate offers over the existing skill. Takes ~10–20s.
              </div>
            )}

            {notes && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {notes.suggestions.map((s, i) => (
                  <div
                    key={i}
                    style={{
                      padding: 10,
                      border: `1px solid ${suggestionColor(s.kind)}`,
                      borderLeft: `4px solid ${suggestionColor(s.kind)}`,
                      borderRadius: 4,
                      background: 'var(--surface)',
                    }}
                  >
                    <div style={{ fontSize: 11, color: suggestionColor(s.kind), textTransform: 'uppercase', marginBottom: 4 }}>
                      {suggestionBadge(s.kind)}
                    </div>
                    <div style={{ fontSize: 13 }}>{s.text}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import type { BaselineDiff } from '../api'
import { acceptSkillBaseline, fetchBaselineDiff } from '../api'

interface Props {
  skillId: string
  onClose: () => void
  onAccepted: () => void
}

export default function DiffModal({ skillId, onClose, onAccepted }: Props) {
  const [diff, setDiff] = useState<BaselineDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [accepting, setAccepting] = useState(false)

  useEffect(() => {
    fetchBaselineDiff(skillId)
      .then(setDiff)
      .catch(e => setError((e as Error).message))
  }, [skillId])

  async function handleAccept() {
    setAccepting(true)
    try {
      await acceptSkillBaseline(skillId)
      onAccepted()
    } catch (e) {
      setError((e as Error).message)
      setAccepting(false)
    }
  }

  const hasFmChanges = diff?.frontmatterChanges && diff.frontmatterChanges.length > 0
  const hasBodyChanges = diff?.bodyBefore !== undefined

  return (
    <div
      className="modal-overlay"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="modal" style={{ maxWidth: 640, width: '90vw' }}>
        <div className="modal-header">
          <div className="modal-title">Changes since last baseline</div>
          <button className="btn btn-sm modal-close" onClick={onClose}>×</button>
        </div>

        {error && (
          <p style={{ color: 'var(--color-error)', fontSize: 13, margin: '0 0 12px' }}>{error}</p>
        )}

        {!diff && !error && (
          <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: '0 0 12px' }}>Loading…</p>
        )}

        {diff && diff.kind !== 'shadow-edit' && (
          <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: '0 0 12px' }}>
            No differences found.
          </p>
        )}

        {diff && diff.kind === 'shadow-edit' && (
          <>
            {hasFmChanges && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-dim)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Frontmatter changes
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Field</th>
                      <th style={thStyle}>Before</th>
                      <th style={thStyle}>After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diff.frontmatterChanges!.map(c => (
                      <tr key={c.key}>
                        <td style={tdStyle}><code>{c.key}</code></td>
                        <td style={{ ...tdStyle, color: 'var(--color-error)' }}>
                          {c.before === undefined ? <em style={{ color: 'var(--text-dim)' }}>—</em> : String(c.before)}
                        </td>
                        <td style={{ ...tdStyle, color: 'var(--color-ok)' }}>
                          {c.after === undefined ? <em style={{ color: 'var(--text-dim)' }}>—</em> : String(c.after)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {hasBodyChanges && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-dim)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Body changes
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>Before</div>
                    <pre style={preStyle}>{diff.bodyBefore}</pre>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>After</div>
                    <pre style={preStyle}>{diff.bodyAfter}</pre>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
          <button
            className="btn btn-sm btn-primary"
            disabled={accepting || !diff}
            onClick={handleAccept}
            title="Mark this content as the new baseline — clears the shadow-edit warning."
          >
            {accepting ? 'Accepting…' : 'Accept as new baseline'}
          </button>
        </div>
      </div>
    </div>
  )
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '4px 8px',
  borderBottom: '1px solid var(--border)',
  fontSize: 12,
  color: 'var(--text-dim)',
  fontWeight: 600,
}

const tdStyle: React.CSSProperties = {
  padding: '4px 8px',
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'top',
  wordBreak: 'break-word',
}

const preStyle: React.CSSProperties = {
  margin: 0,
  padding: 8,
  fontSize: 11,
  fontFamily: 'monospace',
  background: 'var(--bg-alt)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  overflow: 'auto',
  maxHeight: 240,
  whiteSpace: 'pre-wrap',
}

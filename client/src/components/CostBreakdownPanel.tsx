import { useEffect, useState } from 'react'
import { fetchCostBreakdown } from '../api'
import type { BreakdownSession, BreakdownTurn } from '../api'
import type { Skill, Timeframe } from '../types'

const TF_LABELS: Record<Timeframe, string> = {
  day: 'last 24h',
  week: 'last 7d',
  month: 'last 30d',
  quarter: 'last 90d',
  year: 'last 1y',
  all: 'all time',
}

interface Props {
  skill: Skill
  onClose: () => void
  timeframe?: Timeframe
}

function formatTurnDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function fmtDollars(n: number): string {
  if (n >= 0.0001) return '$' + n.toFixed(4)
  return '$' + n.toFixed(6)
}

function TurnRow({ turn }: { turn: BreakdownTurn }) {
  const inputSide = turn.inputTokens + turn.cacheCreationTokens + turn.cacheReadTokens
  return (
    <tr>
      <td className="col-turn-time">{formatTurnDate(turn.ts)}</td>
      <td className="col-turn-attr">
        <span className={`attribution-badge attribution-${turn.attribution}`}>
          {turn.attribution}
        </span>
      </td>
      <td className="col-turn-tokens">{inputSide.toLocaleString()}</td>
      <td className="col-turn-cost">{fmtDollars(turn.dollars)}</td>
    </tr>
  )
}

export default function CostBreakdownPanel({ skill, onClose, timeframe }: Props) {
  const [sessions, setSessions] = useState<BreakdownSession[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setSessions(null)
    setError(null)
    fetchCostBreakdown(skill.id, timeframe)
      .then(breakdown => {
        setSessions(breakdown)
        setLoading(false)
      })
      .catch(e => {
        setError((e as Error).message)
        setLoading(false)
      })
  }, [skill.id, timeframe])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const totalDollars = sessions
    ? sessions.flatMap(s => s.turns).reduce((sum, t) => sum + t.dollars, 0)
    : 0

  const totalTurns = sessions ? sessions.flatMap(s => s.turns).length : 0

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-breakdown" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 className="modal-title">{skill.name}</h2>
            <div className="modal-subtitle">
              Cost breakdown{timeframe ? ` · ${TF_LABELS[timeframe]}` : ''}
            </div>
          </div>
          <button className="modal-close btn btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {loading && (
          <div className="modal-section" style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '40px 0' }}>
            <div className="spinner" style={{ margin: '0 auto' }} />
            <div style={{ marginTop: 12 }}>Loading breakdown…</div>
          </div>
        )}

        {!loading && error && (
          <div className="modal-section" style={{ color: '#f57a7a' }}>
            Error: {error}
          </div>
        )}

        {!loading && !error && sessions !== null && sessions.length === 0 && (
          <div className="modal-section" style={{ color: 'var(--text-dim)', textAlign: 'center', padding: '40px 0' }}>
            No cost data found for this skill.
          </div>
        )}

        {!loading && !error && sessions !== null && sessions.length > 0 && (
          <>
            {sessions.map(session => (
              <div key={session.sessionFile} className="breakdown-session">
                <div className="breakdown-session-header">
                  Session <code>{session.sessionFile.slice(0, 8)}</code>
                  <span className="breakdown-session-count">{session.turns.length} turn{session.turns.length !== 1 ? 's' : ''}</span>
                </div>
                <table className="breakdown-table">
                  <thead>
                    <tr>
                      <th className="col-turn-time">Time</th>
                      <th className="col-turn-attr">Attribution</th>
                      <th className="col-turn-tokens">Input tokens</th>
                      <th className="col-turn-cost">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {session.turns.map((turn, i) => (
                      <TurnRow key={i} turn={turn} />
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

            <div className="breakdown-footer">
              <span className="breakdown-footer-label">
                Total across {totalTurns} turn{totalTurns !== 1 ? 's' : ''}
              </span>
              <span className="breakdown-footer-total">{fmtDollars(totalDollars)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

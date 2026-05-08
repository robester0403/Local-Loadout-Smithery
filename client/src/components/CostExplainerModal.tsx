import { useEffect, useState } from 'react'
import { fetchSampleTurn } from '../api'
import type { SampleTurn } from '../api'
import type { Timeframe } from '../types'

interface Props {
  onClose: () => void
  timeframe?: Timeframe
}

export default function CostExplainerModal({ onClose, timeframe }: Props) {
  const [sample, setSample] = useState<SampleTurn | null | 'loading'>('loading')

  useEffect(() => {
    setSample('loading')
    fetchSampleTurn(timeframe)
      .then(s => setSample(s))
      .catch(() => setSample(null))
  }, [timeframe])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">How cost tracking works</h2>
          <button className="modal-close btn btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal-section">
          <div className="modal-section-title">Two axes of cost</div>
          <p>
            <strong>Active cost</strong> is the body-token tax a skill pays while its full body is
            in context. The pipeline detects activation by watching{' '}
            <code>cache_creation_input_tokens</code> deltas — when a large delta matches a skill's
            known body size, that turn is an activation. The body's tokens are charged at the
            cache_write rate on activation, then cache_read on every subsequent turn until the
            session compacts.
          </p>
          <p style={{ marginTop: 8 }}>
            <strong>Loaded cost</strong> is the listing-token tax every skill pays on every turn.
            Claude Code always includes each installed skill's name and description in the system
            prompt, even skills you never invoke. Each turn you pay for those listing tokens at the
            cache_write rate (first turn of a session) or cache_read rate (all subsequent turns).
          </p>
        </div>

        <div className="modal-section">
          <div className="modal-section-title">Cost by type</div>
          <table className="rules-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Active cost</th>
                <th>Loaded cost</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><span className="type-badge type-skill">skill</span></td>
                <td>Yes</td>
                <td>Yes — metadata always in context</td>
              </tr>
              <tr>
                <td><span className="type-badge type-subagent">subagent</span></td>
                <td>Yes</td>
                <td>Yes — metadata always in context</td>
              </tr>
              <tr>
                <td><span className="type-badge type-command">cmd</span></td>
                <td>Yes</td>
                <td>No — only injected when invoked</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="modal-section">
          <div className="modal-section-title">The math</div>
          <p>
            Loaded cost per turn:{' '}
            <code>countTokens(name + description) × budget_scale × cache_rate</code>.
            Budget scale is{' '}
            <code>min(1, 8000 bytes / total listing bytes)</code> — applied when the combined
            listing exceeds Claude Code's 8000-byte budget. The first assistant turn of each
            session pays cache_write; all subsequent turns pay the much cheaper cache_read rate.
          </p>
          {sample === 'loading' && (
            <div className="sample-box" style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>
              Loading sample…
            </div>
          )}
          {sample !== 'loading' && sample !== null && (
            <div className="sample-box">
              <div className="sample-box-label">Live example — {sample.skillName}</div>
              <div className="sample-box-formula">{sample.formula}</div>
              <div className="sample-box-meta">
                ≈ ${sample.dollars.toFixed(6)} for that turn · model: {sample.model}
              </div>
            </div>
          )}
        </div>

        <div className="modal-section">
          <div className="modal-section-title">Why it matters</div>
          <p>
            A skill that sits in your context window but never gets invoked is a silent tax. Every
            conversation you have — even completely unrelated ones — pays a proportional share of
            that skill's context weight. Over thousands of turns, a large unused skill can cost
            more in loaded context than it ever saved in productivity. That's what the{' '}
            <strong>removal candidate</strong> diagnostic flags.
          </p>
        </div>

        <div className="modal-section">
          <div className="modal-section-title">Activation profiles</div>
          <p>
            Claude Code already filters skills by description match before loading. Profiles let
            you go further by <em>physically disabling</em> skills you don't need for the current
            task — they disappear from Claude's context entirely until you switch back.
          </p>
          <p style={{ marginTop: 8 }}>
            Use profiles for sharp context separation (e.g. <em>work</em> vs. <em>personal</em>);
            rely on description quality for everything else. The <strong>⚡ profile switcher</strong>{' '}
            in the header activates a profile and bulk-disables everything outside it. Switching
            back to <em>All skills</em> restores exactly what it disabled — without touching skills
            you had manually disabled beforehand.
          </p>
        </div>
      </div>
    </div>
  )
}

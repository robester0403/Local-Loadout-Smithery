import { useEffect, useState } from 'react'
import { fetchSampleTurn } from '../api'
import type { SampleTurn } from '../api'

interface Props {
  onClose: () => void
}

export default function CostExplainerModal({ onClose }: Props) {
  const [sample, setSample] = useState<SampleTurn | null | 'loading'>('loading')

  useEffect(() => {
    fetchSampleTurn()
      .then(s => setSample(s))
      .catch(() => setSample(null))
  }, [])

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
            <strong>Active cost</strong> is attributed when you invoke a skill directly — via{' '}
            <code>/skill-name</code>. Every assistant turn in that session until the next command
            invocation counts toward that skill. This is the cost the skill <em>caused</em>.
          </p>
          <p style={{ marginTop: 8 }}>
            <strong>Loaded cost</strong> is a context tax every skill pays on every turn, simply
            by existing in your context window. Even if you never invoke a skill in a session, its
            body occupies tokens that the model has to process. You pay a proportional share of
            every input-side token cost, every turn, for every loaded skill.
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
                <td>Yes</td>
              </tr>
              <tr>
                <td><span className="type-badge type-subagent">subagent</span></td>
                <td>Yes</td>
                <td>Yes</td>
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
            Loaded cost is computed as:{' '}
            <code>(skill bytes ÷ total loaded bytes) × turn input-side tokens</code>.
            Input-side means regular input tokens + cache creation tokens + cache read tokens.
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
      </div>
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import type { Candidate, CandidateType, AutoSkillAccount, OllamaModel } from '../api'
import { acceptCandidate, fetchAutoSkillAccounts, fetchOllamaModels, synthBodyApi } from '../api'
import type { Skill } from '../types'

// Rough param-size extraction from an Ollama tag (e.g. "qwen2.5:7b" → 7).
// Used to default the synth-body picker to the largest installed model.
function paramSize(name: string): number {
  const m = name.match(/[:\-_]?(\d+(?:\.\d+)?)b\b/i)
  return m ? parseFloat(m[1]) : 0
}

interface Props {
  candidate: Candidate
  allSkills: Skill[]
  onClose: () => void
  onAccepted: (path: string, updated: Candidate) => void
}

function deriveProjects(skills: Skill[]): { path: string; label: string }[] {
  const byPath = new Map<string, string>()
  for (const s of skills) {
    if (!s.projectId) continue
    if (!byPath.has(s.projectId)) byPath.set(s.projectId, s.projectId)
  }
  return Array.from(byPath.entries())
    .map(([p, l]) => ({ path: p, label: l }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

export default function AcceptCandidateModal({ candidate, allSkills, onClose, onAccepted }: Props) {
  const projects = useMemo(() => deriveProjects(allSkills), [allSkills])

  const [accounts, setAccounts] = useState<AutoSkillAccount[]>([])
  const [accountDir, setAccountDir] = useState('')
  const [scope, setScope] = useState<'global' | 'project'>('global')
  const [projectPath, setProjectPath] = useState(projects[0]?.path ?? '')
  const [type, setType] = useState<CandidateType>(candidate.suggestedType)
  const [name, setName] = useState(candidate.name)
  const [description, setDescription] = useState(candidate.description)
  const [body, setBody] = useState(candidate.bodyDraft)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<OllamaModel[]>([])
  const [synthModel, setSynthModel] = useState('')
  const [synthing, setSynthing] = useState(false)
  const [synthMessage, setSynthMessage] = useState('')

  useEffect(() => {
    fetchAutoSkillAccounts().then(list => {
      setAccounts(list)
      if (list.length > 0 && !accountDir) setAccountDir(list[0].dir)
    }).catch(e => setError((e as Error).message))

    // Default the synth picker to the largest installed model — if you have
    // both 3b and 7b, 7b is the natural pick for body generation.
    fetchOllamaModels().then(r => {
      if (!r.available) return
      setModels(r.models)
      const sorted = [...r.models].sort((a, b) => paramSize(b.name) - paramSize(a.name))
      if (sorted[0]) setSynthModel(sorted[0].name)
    }).catch(() => { /* Auto Skill still works without synth */ })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSynth() {
    setSynthing(true)
    setSynthMessage('')
    setError(null)
    try {
      const result = await synthBodyApi(candidate.id, { model: synthModel })
      setBody(result.candidate.bodyDraft)
      setSynthMessage(`Body regenerated with ${result.synthesizedWith}.`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSynthing(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const result = await acceptCandidate(candidate.id, {
        accountDir,
        scope,
        projectPath: scope === 'project' ? projectPath : undefined,
        name,
        description,
        body,
        type,
      })
      onAccepted(result.path, result.candidate)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 760 }}>
        <div className="modal-header">
          <div>
            <div className="modal-title">Accept candidate</div>
            <div className="modal-subtitle">Finalize fields and write to a loadout dir.</div>
          </div>
          <button className="btn btn-sm modal-close" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label className="form-label">Type</label>
              <select className="form-input" value={type} onChange={e => setType(e.target.value as CandidateType)}>
                <option value="skill">Skill</option>
                <option value="command">Command</option>
                <option value="subagent">Subagent</option>
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label className="form-label">Scope</label>
              <select className="form-input" value={scope} onChange={e => setScope(e.target.value as 'global' | 'project')}>
                <option value="global">Global</option>
                <option value="project" disabled={projects.length === 0}>Project{projects.length === 0 ? ' (none)' : ''}</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label className="form-label">Account</label>
              <select className="form-input" value={accountDir} onChange={e => setAccountDir(e.target.value)}>
                {accounts.map(a => <option key={a.dir} value={a.dir}>{a.label}</option>)}
              </select>
            </div>
            {scope === 'project' && (
              <div style={{ flex: 1 }}>
                <label className="form-label">Project</label>
                <select className="form-input" value={projectPath} onChange={e => setProjectPath(e.target.value)}>
                  {projects.map(p => <option key={p.path} value={p.path}>{p.label}</option>)}
                </select>
              </div>
            )}
          </div>

          <div>
            <label className="form-label">Name</label>
            <input className="form-input" type="text" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div>
            <label className="form-label">Description</label>
            <textarea className="form-input" rows={2} value={description} onChange={e => setDescription(e.target.value)} />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
              <label className="form-label" style={{ margin: 0 }}>Body</label>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                <select
                  className="form-input"
                  style={{ width: 'auto', padding: '4px 6px', fontSize: 12 }}
                  value={synthModel}
                  onChange={e => setSynthModel(e.target.value)}
                  disabled={models.length === 0 || synthing}
                >
                  {models.length === 0 && <option value="">(no models)</option>}
                  {models.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
                </select>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handleSynth}
                  disabled={synthing || !synthModel}
                  title="Regenerate the body with the selected model. Use a larger model (e.g. 7B/14B) for higher quality output."
                >
                  {synthing ? 'Generating…' : 'Regenerate body'}
                </button>
              </div>
            </div>
            {synthMessage && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>{synthMessage}</div>}
            <textarea className="form-input" rows={12} value={body} onChange={e => setBody(e.target.value)} />
          </div>

          {error && <div className="form-error">{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={submitting || !accountDir}>
              {submitting ? 'Writing…' : 'Create skill'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

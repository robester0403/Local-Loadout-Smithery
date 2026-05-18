import { useEffect, useMemo, useState } from 'react'
import type { Candidate, CandidateType, HarvesterAccount } from '../api'
import { acceptCandidate, fetchHarvesterAccounts } from '../api'
import type { Skill } from '../types'

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

  const [accounts, setAccounts] = useState<HarvesterAccount[]>([])
  const [accountDir, setAccountDir] = useState('')
  const [scope, setScope] = useState<'global' | 'project'>('global')
  const [projectPath, setProjectPath] = useState(projects[0]?.path ?? '')
  const [type, setType] = useState<CandidateType>(candidate.suggestedType)
  const [name, setName] = useState(candidate.name)
  const [description, setDescription] = useState(candidate.description)
  const [body, setBody] = useState(candidate.bodyDraft)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchHarvesterAccounts().then(list => {
      setAccounts(list)
      if (list.length > 0 && !accountDir) setAccountDir(list[0].dir)
    }).catch(e => setError((e as Error).message))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
            <label className="form-label">Body</label>
            <textarea className="form-input" rows={10} value={body} onChange={e => setBody(e.target.value)} />
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

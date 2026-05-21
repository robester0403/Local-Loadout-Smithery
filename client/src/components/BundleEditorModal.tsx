import { useMemo, useState } from 'react'
import type { Skill } from '../types'
import type {
  Bundle,
  BundleInput,
  BundleScope,
  BundleSkillEntry,
  BundleTarget,
  BundleValidationError,
} from '../api'
import { createBundleApi, updateBundleApi } from '../api'

interface Props {
  initial?: Bundle
  initialSkillIds?: string[]
  allSkills: Skill[]
  onClose: () => void
  onSaved: (b: Bundle) => void
}

function deriveProjects(skills: Skill[]): { path: string; label: string }[] {
  const byPath = new Map<string, string>()
  for (const s of skills) {
    if (!s.projectId) continue
    if (!byPath.has(s.projectId)) byPath.set(s.projectId, s.projectId)
  }
  return Array.from(byPath.entries())
    .map(([path, label]) => ({ path, label }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

function sourceHasDescription(s: Skill | undefined): boolean {
  return !!s && !!s.description && s.description.trim().length > 0
}

export default function BundleEditorModal({
  initial,
  initialSkillIds,
  allSkills,
  onClose,
  onSaved,
}: Props) {
  const projects = useMemo(() => deriveProjects(allSkills), [allSkills])

  const [name, setName] = useState(initial?.name ?? '')
  const [trigger, setTrigger] = useState(initial?.trigger ?? '')
  const [target, setTarget] = useState<BundleTarget>(initial?.target ?? 'claude')
  const [scopeKind, setScopeKind] = useState<'global' | 'project'>(initial?.scope.kind ?? 'global')
  const [projectPath, setProjectPath] = useState<string>(
    initial?.scope.kind === 'project' ? initial.scope.path : projects[0]?.path ?? '',
  )
  const [entries, setEntries] = useState<BundleSkillEntry[]>(
    initial?.skills ?? (initialSkillIds ?? []).map(id => ({ id })),
  )

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<BundleValidationError[]>([])

  const skillsById = useMemo(() => {
    const m = new Map<string, Skill>()
    for (const s of allSkills) m.set(s.id, s)
    return m
  }, [allSkills])

  const offendingFromServer = useMemo(() => {
    const set = new Set<string>()
    for (const e of fieldErrors) for (const id of e.offendingSkillIds ?? []) set.add(id)
    return set
  }, [fieldErrors])

  function fieldError(field: BundleValidationError['field']): string | undefined {
    return fieldErrors.find(e => e.field === field)?.message
  }

  function removeEntry(id: string) {
    setEntries(prev => prev.filter(e => e.id !== id))
  }

  function setEntryDescription(id: string, value: string) {
    setEntries(prev => prev.map(e => e.id === id ? { ...e, description: value } : e))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setFieldErrors([])

    const scope: BundleScope = scopeKind === 'global'
      ? { kind: 'global' }
      : { kind: 'project', path: projectPath }

    // Drop empty per-entry descriptions before send — the server treats
    // absent and empty the same, but this keeps the wire payload clean.
    const cleanedEntries: BundleSkillEntry[] = entries.map(e => {
      const trimmed = e.description?.trim()
      return trimmed ? { id: e.id, description: trimmed } : { id: e.id }
    })

    const input: BundleInput = {
      name: name.trim(),
      target,
      scope,
      trigger: trigger.trim(),
      skills: cleanedEntries,
    }
    setSubmitting(true)
    try {
      const saved = initial
        ? await updateBundleApi(initial.id, input)
        : await createBundleApi(input)
      onSaved(saved)
    } catch (err) {
      const e = err as Error & { details?: BundleValidationError[] }
      if (e.details) setFieldErrors(e.details)
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={{ maxWidth: 760 }}>
        <div className="modal-header">
          <div>
            <div className="modal-title">
              {initial ? 'Edit routing bundle' : 'New routing bundle'}
            </div>
            <div className="modal-subtitle">
              Group skills behind a trigger. Items missing a source description need a "when to use" note.
            </div>
          </div>
          <button className="btn btn-sm modal-close" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label className="form-label">Name</label>
            <input
              className="form-input"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Refactoring tasks"
              autoFocus
            />
            {fieldError('name') && <div className="form-error">{fieldError('name')}</div>}
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label className="form-label">Target</label>
              <select
                className="form-input"
                value={target}
                onChange={e => setTarget(e.target.value as BundleTarget)}
              >
                <option value="claude">Claude</option>
                <option value="cursor">Cursor</option>
                <option value="codex">Codex</option>
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label className="form-label">Scope</label>
              <select
                className="form-input"
                value={scopeKind}
                onChange={e => setScopeKind(e.target.value as 'global' | 'project')}
              >
                <option value="global">Global</option>
                <option value="project" disabled={projects.length === 0}>
                  Project{projects.length === 0 ? ' (none detected)' : ''}
                </option>
              </select>
            </div>
          </div>

          {scopeKind === 'project' && (
            <div>
              <label className="form-label">Project</label>
              <select
                className="form-input"
                value={projectPath}
                onChange={e => setProjectPath(e.target.value)}
              >
                {projects.length === 0 && <option value="">No projects detected</option>}
                {projects.map(p => (
                  <option key={p.path} value={p.path}>{p.label}</option>
                ))}
              </select>
              {fieldError('scope') && <div className="form-error">{fieldError('scope')}</div>}
            </div>
          )}

          <div>
            <label className="form-label">Trigger condition</label>
            <textarea
              className="form-input"
              rows={3}
              value={trigger}
              onChange={e => setTrigger(e.target.value)}
              placeholder="When the user wants to refactor existing code, restructure files, or clean up technical debt."
            />
            {fieldError('trigger') && <div className="form-error">{fieldError('trigger')}</div>}
          </div>

          <div>
            <label className="form-label">Skills in bundle ({entries.length})</label>
            {entries.length === 0 && (
              <div className="form-error">No skills selected. Select skills from the inventory before creating a bundle.</div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {entries.map(entry => {
                const source = skillsById.get(entry.id)
                const hasSource = sourceHasDescription(source)
                const userText = entry.description?.trim() ?? ''
                const needsDescription = !hasSource && userText.length === 0
                const flaggedByServer = offendingFromServer.has(entry.id)
                const bad = needsDescription || flaggedByServer
                return (
                  <div
                    key={entry.id}
                    style={{
                      border: `1px solid ${bad ? 'var(--c-danger)' : 'var(--border)'}`,
                      borderRadius: 6,
                      padding: 10,
                      background: bad ? 'rgba(248, 107, 99, 0.06)' : 'var(--surface)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                      <span>
                        {source && <span className={`type-badge type-${source.type}`}>{source.type}</span>}{' '}
                        <strong>{source?.name ?? entry.id}</strong>
                      </span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => removeEntry(entry.id)}
                      >Remove</button>
                    </div>
                    {hasSource ? (
                      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
                        Source description: {source!.description}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--c-danger)', marginTop: 4 }}>
                        Source has no description. Add a "when to use" note for this bundle.
                      </div>
                    )}
                    <textarea
                      className="form-input"
                      rows={2}
                      style={{ marginTop: 6 }}
                      value={entry.description ?? ''}
                      onChange={e => setEntryDescription(entry.id, e.target.value)}
                      placeholder={
                        hasSource
                          ? '(optional) Override or sharpen for this bundle…'
                          : 'Required: when should the LLM pick this skill?'
                      }
                    />
                  </div>
                )
              })}
            </div>
            {fieldError('skills') && <div className="form-error">{fieldError('skills')}</div>}
          </div>

          {error && !fieldErrors.length && <div className="form-error">{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 6 }}>
            <button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-sm btn-primary" disabled={submitting}>
              {submitting ? 'Saving…' : initial ? 'Save changes' : 'Create bundle'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

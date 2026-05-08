import { useState, useEffect, useCallback } from 'react'
import type { Skill } from '../types'
import type { SRGroup, SuperRouterStateData } from '../api'
import {
  fetchSuperRouterState,
  superRouterGlobalToggle,
  createSRGroup,
  updateSRGroup,
  deleteSRGroup,
  addSRMember,
  removeSRMember,
} from '../api'
import ToggleSwitch from './ToggleSwitch'
import EmptyState from './EmptyState'

interface Props {
  skills: Skill[]
  onToast: (msg: string) => void
}

// ─── keyword overlap score for auto-suggest ─────────────────────────────────
function overlapScore(skillDesc: string, keywords: string[]): number {
  if (keywords.length === 0) return 0
  const desc = skillDesc.toLowerCase()
  return keywords.filter(kw => desc.includes(kw.toLowerCase())).length
}

// ─── Tag input ───────────────────────────────────────────────────────────────
function TagInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [input, setInput] = useState('')

  function commit() {
    const v = input.trim().replace(/,+$/, '').trim()
    if (v && !tags.includes(v)) onChange([...tags, v])
    setInput('')
  }

  return (
    <div className="sr-tag-input">
      {tags.map(t => (
        <span key={t} className="sr-tag">
          {t}
          <button className="sr-tag-remove" onClick={() => onChange(tags.filter(x => x !== t))}>×</button>
        </span>
      ))}
      <input
        className="sr-tag-field"
        value={input}
        placeholder="type + Enter"
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit() }
          if (e.key === 'Backspace' && !input && tags.length) onChange(tags.slice(0, -1))
        }}
        onBlur={commit}
      />
    </div>
  )
}

// ─── Create / Edit group modal ───────────────────────────────────────────────
interface GroupFormData {
  name: string
  description: string
  keywords: string[]
  scope: 'global' | 'project'
  projectPath: string
}

interface GroupModalProps {
  initial?: SRGroup
  onSave: (data: GroupFormData) => Promise<void>
  onClose: () => void
}

function GroupModal({ initial, onSave, onClose }: GroupModalProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [keywords, setKeywords] = useState<string[]>(initial?.keywords ?? [])
  const [scope, setScope] = useState<'global' | 'project'>(initial?.scope ?? 'global')
  const [projectPath, setProjectPath] = useState(initial?.projectPath ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    if (!name.trim()) { setError('Name is required'); return }
    if (!description.trim()) { setError('Description is required'); return }
    setSaving(true)
    setError(null)
    try {
      await onSave({ name: name.trim(), description: description.trim(), keywords, scope, projectPath: projectPath.trim() })
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal sr-modal">
        <div className="modal-header">
          <div>
            <div className="modal-title">{initial ? 'Edit Group' : 'New Group'}</div>
            <div className="modal-subtitle">Define when Claude should use skills in this group</div>
          </div>
          <button className="btn btn-sm modal-close" onClick={onClose}>×</button>
        </div>

        <div className="sr-form">
          <label className="sr-form-label">Name</label>
          <input
            className="sr-form-input"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Career tools"
            autoFocus
          />

          <label className="sr-form-label">Description <span className="sr-form-hint">(shown to Claude as routing context)</span></label>
          <textarea
            className="sr-form-textarea"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="e.g. Skills related to job search, career planning, and professional development"
            rows={3}
          />

          <label className="sr-form-label">Trigger keywords <span className="sr-form-hint">(Claude/hook routes here when these words appear in prompt)</span></label>
          <TagInput tags={keywords} onChange={setKeywords} />

          <label className="sr-form-label">Scope</label>
          <div className="sr-scope-toggle">
            <button
              className={`pill ${scope === 'global' ? 'active' : ''}`}
              onClick={() => setScope('global')}
            >global</button>
            <button
              className={`pill ${scope === 'project' ? 'active' : ''}`}
              onClick={() => setScope('project')}
            >project</button>
          </div>

          {scope === 'project' && (
            <>
              <label className="sr-form-label">Project path</label>
              <input
                className="sr-form-input"
                value={projectPath}
                onChange={e => setProjectPath(e.target.value)}
                placeholder="/Users/you/Code/my-project"
              />
            </>
          )}

          {error && <div className="sr-form-error">{error}</div>}

          <div className="sr-form-actions">
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? '…' : initial ? 'Save changes' : 'Create group'}
            </button>
            <button className="btn" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Skill picker for adding members ────────────────────────────────────────
interface SkillPickerProps {
  skills: Skill[]
  group: SRGroup
  onAdd: (skill: Skill) => Promise<void>
  onClose: () => void
}

function SkillPicker({ skills, group, onAdd, onClose }: SkillPickerProps) {
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState<string | null>(null)

  const memberIds = new Set(group.members.map(m => m.skillId))
  const candidates = skills.filter(s => !memberIds.has(s.id))

  const filtered = candidates.filter(s => {
    if (!search) return true
    const q = search.toLowerCase()
    return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
  })

  // P12.8: sort by keyword overlap (descending), then name
  const sorted = [...filtered].sort((a, b) => {
    const sa = overlapScore(a.description, group.keywords)
    const sb = overlapScore(b.description, group.keywords)
    if (sb !== sa) return sb - sa
    return a.name.localeCompare(b.name)
  })

  async function handleAdd(skill: Skill) {
    setAdding(skill.id)
    try {
      await onAdd(skill)
    } finally {
      setAdding(null)
    }
  }

  return (
    <div className="sr-picker">
      <div className="sr-picker-header">
        <span className="sr-picker-title">Add member</span>
        <button className="btn btn-sm" onClick={onClose}>×</button>
      </div>
      <input
        className="sr-form-input"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search skills…"
        autoFocus
      />
      <div className="sr-picker-list">
        {sorted.length === 0 && (
          <div className="sr-picker-empty">{candidates.length === 0 ? 'All skills already in group' : 'No matches'}</div>
        )}
        {sorted.map(s => {
          const score = overlapScore(s.description, group.keywords)
          return (
            <div key={s.id} className="sr-picker-row">
              <div className="sr-picker-info">
                <span className="sr-picker-name">{s.name}</span>
                {score > 0 && (
                  <span className="sr-suggest-badge" title={`${score} keyword overlap`}>
                    ✦ suggested
                  </span>
                )}
                <span className="sr-picker-desc">{s.description}</span>
              </div>
              <button
                className="btn btn-sm"
                onClick={() => handleAdd(s)}
                disabled={adding === s.id}
              >
                {adding === s.id ? '…' : '+ Add'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Group detail drawer ─────────────────────────────────────────────────────
interface GroupDetailProps {
  group: SRGroup
  skills: Skill[]
  onClose: () => void
  onGroupUpdated: (g: SRGroup) => void
  onGroupDeleted: () => void
  onToast: (msg: string) => void
}

function GroupDetail({ group, skills, onClose, onGroupUpdated, onGroupDeleted, onToast }: GroupDetailProps) {
  const [editing, setEditing] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  // build skill lookup by id
  const skillById = new Map(skills.map(s => [s.id, s]))

  async function handleEdit(data: GroupFormData) {
    const updated = await updateSRGroup(group.id, {
      name: data.name,
      description: data.description,
      keywords: data.keywords,
      scope: data.scope,
      projectPath: data.scope === 'project' ? data.projectPath : undefined,
    })
    onGroupUpdated(updated)
  }

  async function handleDelete() {
    if (!window.confirm(`Delete group "${group.name}"? This cannot be undone.`)) return
    await deleteSRGroup(group.id)
    onGroupDeleted()
  }

  async function handleRemove(skillId: string) {
    setRemoving(skillId)
    try {
      await removeSRMember(group.id, skillId)
      onGroupUpdated({
        ...group,
        members: group.members.filter(m => m.skillId !== skillId),
        driftedMembers: group.driftedMembers?.filter(id => id !== skillId),
      })
    } catch (e) {
      onToast((e as Error).message)
    } finally {
      setRemoving(null)
    }
  }

  async function handleAdd(skill: Skill) {
    await addSRMember(group.id, skill.id, skill.name, skill.description)
    onGroupUpdated({
      ...group,
      members: [
        ...group.members,
        { skillId: skill.id, addedAt: new Date().toISOString(), contentHash: '' },
      ],
    })
  }

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-header">
          <div className="drawer-title-row">
            <span className="drawer-title">{group.name}</span>
            <span className={`scope-badge scope-${group.scope}`}>{group.scope}</span>
          </div>
          <div className="drawer-desc">{group.description}</div>
          {group.keywords.length > 0 && (
            <div className="sr-keyword-row">
              {group.keywords.map(k => <span key={k} className="sr-tag sr-tag-dim">{k}</span>)}
            </div>
          )}
          <div className="drawer-actions">
            <button className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn btn-sm btn-warn" onClick={handleDelete}>Delete</button>
            <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={onClose}>×</button>
          </div>
        </div>

        <div className="drawer-body">
          <div className="sr-section-header">
            <span className="sr-section-title">Members ({group.members.length})</span>
            <button className="btn btn-sm" onClick={() => setShowPicker(p => !p)}>
              {showPicker ? 'Close picker' : '+ Add'}
            </button>
          </div>

          {showPicker && (
            <SkillPicker
              skills={skills}
              group={group}
              onAdd={handleAdd}
              onClose={() => setShowPicker(false)}
            />
          )}

          {group.members.length === 0 && !showPicker && (
            <div className="sr-empty-members">No members yet — add skills this group should route to.</div>
          )}

          <div className="sr-member-list">
            {group.members.map(m => {
              const skill = skillById.get(m.skillId)
              const drifted = group.driftedMembers?.includes(m.skillId)
              return (
                <div key={m.skillId} className={`sr-member-row${drifted ? ' sr-member-drifted' : ''}`}>
                  <div className="sr-member-info">
                    <span className="sr-member-name">{skill?.name ?? m.skillId}</span>
                    {drifted && (
                      <span className="sr-drift-badge" title="Skill name or description changed since this member was added — routing context may be stale">
                        🔄 Skill changed since added — review trigger
                      </span>
                    )}
                    {skill && <span className="sr-member-desc">{skill.description}</span>}
                  </div>
                  <button
                    className="btn btn-sm btn-warn"
                    onClick={() => handleRemove(m.skillId)}
                    disabled={removing === m.skillId}
                  >
                    {removing === m.skillId ? '…' : 'Remove'}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {editing && (
        <GroupModal
          initial={group}
          onSave={handleEdit}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  )
}

// ─── Main tab ────────────────────────────────────────────────────────────────
export default function SuperRouterTab({ skills, onToast }: Props) {
  const [srState, setSrState] = useState<SuperRouterStateData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedGroup, setSelectedGroup] = useState<SRGroup | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const state = await fetchSuperRouterState()
      setSrState(state)
      // Sync selected group if it's open
      if (selectedGroup) {
        const updated = state.groups.find(g => g.id === selectedGroup.id)
        setSelectedGroup(updated ?? null)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  async function handleToggleGlobal(enabled: boolean) {
    setSrState(prev => prev ? { ...prev, globalEnabled: enabled } : prev)
    try {
      await superRouterGlobalToggle({ enabled })
    } catch (e) {
      onToast((e as Error).message)
      load()
    }
  }

  async function handleToggleHook(useHook: boolean) {
    setSrState(prev => prev ? { ...prev, useHook } : prev)
    try {
      await superRouterGlobalToggle({ useHook })
      await load()
    } catch (e) {
      onToast((e as Error).message)
      load()
    }
  }

  async function handleToggleGroup(group: SRGroup, enabled: boolean) {
    setSrState(prev => prev
      ? { ...prev, groups: prev.groups.map(g => g.id === group.id ? { ...g, enabled } : g) }
      : prev
    )
    try {
      await updateSRGroup(group.id, { enabled })
    } catch (e) {
      onToast((e as Error).message)
      load()
    }
  }

  async function handleCreate(data: GroupFormData) {
    const group = await createSRGroup({
      name: data.name,
      description: data.description,
      keywords: data.keywords,
      scope: data.scope,
      projectPath: data.scope === 'project' ? data.projectPath : undefined,
    })
    setSrState(prev => prev ? { ...prev, groups: [...prev.groups, group] } : prev)
  }

  function handleGroupUpdated(updated: SRGroup) {
    setSrState(prev => prev
      ? { ...prev, groups: prev.groups.map(g => g.id === updated.id ? updated : g) }
      : prev
    )
    setSelectedGroup(updated)
  }

  function handleGroupDeleted() {
    if (!selectedGroup) return
    setSrState(prev => prev
      ? { ...prev, groups: prev.groups.filter(g => g.id !== selectedGroup.id) }
      : prev
    )
    setSelectedGroup(null)
  }

  if (loading && !srState) return <EmptyState variant="loading" />
  if (error) return <EmptyState variant="error" message={error} onRetry={load} />
  if (!srState) return null

  const { globalEnabled, useHook, hookInstalled, groups } = srState

  return (
    <div className="sr-tab">
      {/* Global controls */}
      <div className="sr-global-bar">
        <div className="sr-global-left">
          <span className="sr-tab-title">SuperRouter</span>
          <span className="sr-tab-sub">Automatic skill routing via CLAUDE.md injection</span>
        </div>
        <div className="sr-global-right">
          <label className="sr-toggle-row">
            <ToggleSwitch checked={globalEnabled} onChange={handleToggleGlobal} />
            <span className="sr-toggle-label">Global enabled</span>
          </label>
          <label className="sr-toggle-row">
            <ToggleSwitch checked={useHook} onChange={handleToggleHook} />
            <span className="sr-toggle-label">
              Use hook for higher reliability
              {!hookInstalled && useHook && (
                <span className="sr-hook-warn" title="Hook not found in ~/.claude/settings.json">⚠</span>
              )}
              {hookInstalled && <span className="sr-hook-ok" title="Hook installed">✓</span>}
            </span>
          </label>
        </div>
      </div>

      {/* Group list */}
      <div className="sr-group-header">
        <span className="sr-section-title">Groups ({groups.length})</span>
        <button className="btn btn-sm btn-primary" onClick={() => setShowCreateModal(true)}>+ New Group</button>
      </div>

      {groups.length === 0 ? (
        <div className="sr-no-groups">
          <div className="sr-no-groups-icon">⚡</div>
          <div className="sr-no-groups-title">No routing groups yet</div>
          <div className="sr-no-groups-sub">Create a group to define which skills Claude should use for specific tasks.</div>
          <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>Create first group</button>
        </div>
      ) : (
        <div className="sr-group-list">
          {groups.map(group => (
            <div
              key={group.id}
              className={`sr-group-row${selectedGroup?.id === group.id ? ' sr-group-selected' : ''}`}
              onClick={() => setSelectedGroup(group)}
            >
              <div className="sr-group-toggle" onClick={e => e.stopPropagation()}>
                <ToggleSwitch
                  checked={group.enabled}
                  onChange={enabled => handleToggleGroup(group, enabled)}
                  title={group.enabled ? 'Disable group' : 'Enable group'}
                />
              </div>
              <div className="sr-group-info">
                <span className="sr-group-name">{group.name}</span>
                {group.driftedMembers && group.driftedMembers.length > 0 && (
                  <span className="sr-drift-pill" title={`${group.driftedMembers.length} member(s) changed since added`}>
                    🔄 {group.driftedMembers.length} drifted
                  </span>
                )}
                <span className="sr-group-desc">{group.description}</span>
              </div>
              <div className="sr-group-meta">
                <span className={`scope-badge scope-${group.scope}`}>{group.scope}</span>
                <span className="sr-member-count">{group.members.length} member{group.members.length !== 1 ? 's' : ''}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {selectedGroup && (
        <GroupDetail
          group={selectedGroup}
          skills={skills}
          onClose={() => setSelectedGroup(null)}
          onGroupUpdated={handleGroupUpdated}
          onGroupDeleted={handleGroupDeleted}
          onToast={onToast}
        />
      )}

      {showCreateModal && (
        <GroupModal
          onSave={handleCreate}
          onClose={() => setShowCreateModal(false)}
        />
      )}
    </div>
  )
}

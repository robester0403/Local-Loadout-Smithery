import { useState, useRef, useEffect } from 'react'
import { IconBolt, IconCheck, IconChevronDown, IconChevronUp, IconX } from '@tabler/icons-react'
import type { ProfilesData } from '../api'

interface Props {
  profilesData: ProfilesData
  allSkillIds: string[]
  onActivate: (name: string | null) => Promise<void>
  onCreate: (name: string, skillIds: string[]) => Promise<void>
  onDelete: (name: string) => Promise<void>
}

export default function ProfileSwitcher({ profilesData, allSkillIds, onActivate, onCreate, onDelete }: Props) {
  const { profiles, activeProfile } = profilesData
  const profileNames = Object.keys(profiles)
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setCreating(false)
        setNewName('')
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  async function handleActivate(name: string | null) {
    setOpen(false)
    await onActivate(name)
  }

  async function handleCreate() {
    const trimmed = newName.trim()
    if (!trimmed) return
    await onCreate(trimmed, allSkillIds)
    setNewName('')
    setCreating(false)
  }

  async function handleDelete(name: string, e: React.MouseEvent) {
    e.stopPropagation()
    if (!window.confirm(`Delete profile "${name}"?`)) return
    await onDelete(name)
  }

  const label = activeProfile ?? 'All skills'

  return (
    <div className="profile-switcher" ref={ref}>
      <button
        className={`btn btn-sm profile-btn ${activeProfile ? 'profile-btn-active' : ''}`}
        onClick={() => setOpen(o => !o)}
        title="Switch activation profile"
      >
        <IconBolt size={14} stroke={1.75} aria-hidden /> {label}
        <span className="profile-chevron">
          {open ? <IconChevronUp size={12} stroke={2} aria-hidden /> : <IconChevronDown size={12} stroke={2} aria-hidden />}
        </span>
      </button>

      {open && (
        <div className="profile-dropdown">
          <div
            className={`profile-option ${activeProfile === null ? 'profile-option-current' : ''}`}
            onClick={() => handleActivate(null)}
          >
            <span>All skills</span>
            {activeProfile === null && <span className="profile-check"><IconCheck size={12} stroke={2} aria-hidden /></span>}
          </div>

          {profileNames.map(name => (
            <div
              key={name}
              className={`profile-option ${activeProfile === name ? 'profile-option-current' : ''}`}
              onClick={() => handleActivate(name)}
            >
              <span className="profile-option-name">{name}</span>
              <span className="profile-option-count">{profiles[name].length} skills</span>
              {activeProfile === name && <span className="profile-check"><IconCheck size={12} stroke={2} aria-hidden /></span>}
              <button
                className="profile-delete-btn"
                onClick={e => handleDelete(name, e)}
                title={`Delete profile "${name}"`}
                aria-label={`Delete profile "${name}"`}
              >
                <IconX size={12} stroke={1.75} aria-hidden />
              </button>
            </div>
          ))}

          <div className="profile-divider" />

          {creating ? (
            <div className="profile-create-row">
              <input
                className="profile-create-input"
                autoFocus
                placeholder="Profile name…"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleCreate()
                  if (e.key === 'Escape') { setCreating(false); setNewName('') }
                }}
              />
              <button className="btn btn-sm" onClick={handleCreate} disabled={!newName.trim()}>
                Save
              </button>
            </div>
          ) : (
            <div className="profile-option profile-new-btn" onClick={() => setCreating(true)}>
              + Save current inventory as profile
            </div>
          )}
        </div>
      )}
    </div>
  )
}

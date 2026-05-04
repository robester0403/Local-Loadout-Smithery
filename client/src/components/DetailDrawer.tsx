import { useEffect } from 'react'
import { marked } from 'marked'
import type { Skill } from '../types'

interface Props {
  skill: Skill
  onClose: () => void
  onOpen: (skill: Skill) => void
  onBreakdown: (skill: Skill) => void
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

const META_ROWS: { label: string; getValue: (s: Skill) => string }[] = [
  { label: 'Type', getValue: s => s.type },
  { label: 'Scope', getValue: s => s.scope },
  { label: 'Account', getValue: s => s.account },
  { label: 'Version', getValue: s => s.version || '—' },
  { label: 'Modified', getValue: s => formatDate(s.lastModified) },
  { label: 'Path', getValue: s => s.path },
  { label: 'Symlink', getValue: s => s.isSymlink ? `Yes → ${s.realpath}` : 'No' },
  { label: 'Project', getValue: s => s.projectId ?? '—' },
]

export default function DetailDrawer({ skill, onClose, onOpen, onBreakdown }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const bodyHtml = skill.body
    ? (marked(skill.body) as string)
    : '<p><em>No body content.</em></p>'

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-header">
          <div className="drawer-title-row">
            <span className={`type-badge type-${skill.type}`}>{skill.type}</span>
            <h2 className="drawer-title">{skill.name}</h2>
          </div>
          {skill.description && (
            <p className="drawer-desc">{skill.description}</p>
          )}
          <div className="drawer-actions">
            <button className="btn btn-primary" onClick={() => onOpen(skill)}>
              Open in editor
            </button>
            <button className="btn" onClick={() => onBreakdown(skill)}>
              Show breakdown
            </button>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>

        <div className="drawer-meta">
          <table className="meta-table">
            <tbody>
              {META_ROWS
                .filter(r => {
                  const v = r.getValue(skill)
                  return v && v !== '—'
                })
                .map(r => (
                  <tr key={r.label}>
                    <th>{r.label}</th>
                    <td>{r.getValue(skill)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        <div
          className="drawer-body markdown-body"
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      </aside>
    </>
  )
}

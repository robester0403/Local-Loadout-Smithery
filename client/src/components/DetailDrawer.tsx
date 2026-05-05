import { useEffect, useState } from 'react'
import { marked } from 'marked'
import type { Skill } from '../types'

interface Props {
  skill: Skill
  allSkills: Skill[]
  onClose: () => void
  onOpen: (skill: Skill) => void
  onBreakdown: (skill: Skill) => void
  onSelect: (skill: Skill) => void
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

const SEVERITY_ICON: Record<string, string> = { error: '✗', warn: '⚠' }

export default function DetailDrawer({ skill, allSkills, onClose, onOpen, onBreakdown, onSelect }: Props) {
  const [issuesOpen, setIssuesOpen] = useState(skill.health.status !== 'ok')

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Auto-expand when a different skill is opened
  useEffect(() => {
    setIssuesOpen(skill.health.status !== 'ok')
  }, [skill.id, skill.health.status])

  const bodyHtml = skill.body
    ? (marked(skill.body) as string)
    : '<p><em>No body content.</em></p>'

  const { issues } = skill.health

  // Outgoing references (from this skill's body/frontmatter)
  const outgoing = skill.references ?? []

  // Inbound references (other skills that mention this skill)
  const inbound = allSkills.filter(s =>
    s.id !== skill.id && s.references?.some(r => r.name === skill.name)
  )

  // (allSkillNames used inline in JSX for broken-ref detection)

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

        {issues.length > 0 && (
          <div className="drawer-accordion">
            <button
              className={`accordion-trigger accordion-trigger-${skill.health.status}`}
              onClick={() => setIssuesOpen(o => !o)}
              aria-expanded={issuesOpen}
            >
              <span className="accordion-icon">{issuesOpen ? '▾' : '▸'}</span>
              <span>
                {skill.health.status === 'error' ? '✗' : '⚠'} {issues.length} {issues.length === 1 ? 'issue' : 'issues'}
              </span>
            </button>
            {issuesOpen && (
              <ul className="accordion-issue-list">
                {issues.map((issue, i) => (
                  <li key={i} className={`accordion-issue accordion-issue-${issue.severity}`}>
                    <span className="accordion-issue-icon">{SEVERITY_ICON[issue.severity]}</span>
                    <span className="accordion-issue-msg">{issue.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="drawer-relationships">
          <div className="rel-summary">
            {outgoing.length === 0 && inbound.length === 0
              ? <span className="rel-orphan">No relationships found — this skill is an island</span>
              : <span className="rel-stat">
                  References {outgoing.length} skill{outgoing.length !== 1 ? 's' : ''}, referenced by {inbound.length}
                </span>
            }
          </div>

          {outgoing.length > 0 && (
            <div className="rel-group">
              <span className="rel-group-label">References</span>
              <ul className="rel-list">
                {outgoing.map(ref => {
                  const target = allSkills.find(s => s.name === ref.name)
                  const isBroken = !target
                  return (
                    <li key={ref.name} className={`rel-item ${isBroken ? 'rel-broken' : ''}`}>
                      {isBroken
                        ? <span className="rel-broken-name" title="Skill not found in inventory">⚠ {ref.name}</span>
                        : <button className="rel-link" onClick={() => onSelect(target!)}>
                            {ref.name}
                          </button>
                      }
                      <span className="rel-source">{ref.source}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {inbound.length > 0 && (
            <div className="rel-group">
              <span className="rel-group-label">Referenced by</span>
              <ul className="rel-list">
                {inbound.map(s => (
                  <li key={s.id} className="rel-item">
                    <button className="rel-link" onClick={() => onSelect(s)}>
                      {s.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
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

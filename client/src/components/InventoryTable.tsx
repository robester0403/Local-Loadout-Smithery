import type { Skill, SortKey, SortDir } from '../types'

interface Props {
  skills: Skill[]
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: SortKey) => void
  selected: Skill | null
  onSelect: (skill: Skill) => void
}

const TYPE_LABELS: Record<string, string> = {
  skill: 'skill',
  command: 'cmd',
  agent: 'agent',
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'type', label: 'Type' },
  { key: 'scope', label: 'Context' },
  { key: 'lastModified', label: 'Modified' },
]

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// projectId is the project path with '/' replaced by '-', e.g. '-Users-bob-Code-my-app'
// The last hyphen-separated segment is the project directory name.
function projectLabel(projectId: string): string {
  const parts = projectId.split('-').filter(Boolean)
  return parts[parts.length - 1] || projectId
}

function ContextCell({ skill }: { skill: Skill }) {
  if (skill.scope === 'global') {
    return <span className="scope-badge scope-global">global</span>
  }
  const label = skill.projectId ? projectLabel(skill.projectId) : 'project'
  return (
    <span className="scope-badge scope-project" title={skill.projectId}>
      {label}
    </span>
  )
}

export default function InventoryTable({
  skills,
  sortKey,
  sortDir,
  onSort,
  selected,
  onSelect,
}: Props) {
  return (
    <div className="table-wrap">
      <table className="inventory-table">
        <thead>
          <tr>
            {COLUMNS.map(col => (
              <th
                key={col.key}
                className={`col-${col.key} ${sortKey === col.key ? 'sorted' : ''}`}
                onClick={() => onSort(col.key)}
              >
                {col.label}
                {sortKey === col.key && (
                  <span className="sort-arrow">{sortDir === 'asc' ? ' ▲' : ' ▼'}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {skills.map(skill => (
            <tr
              key={skill.id}
              className={selected?.id === skill.id ? 'selected' : ''}
              onClick={() => onSelect(skill)}
            >
              <td className="col-name">
                <span className="skill-name">{skill.name}</span>
                {skill.description && (
                  <span className="skill-desc">{skill.description}</span>
                )}
              </td>
              <td className="col-type">
                <span className={`type-badge type-${skill.type}`}>
                  {TYPE_LABELS[skill.type] ?? skill.type}
                </span>
              </td>
              <td className="col-scope">
                <ContextCell skill={skill} />
              </td>
              <td className="col-lastModified">{formatDate(skill.lastModified)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

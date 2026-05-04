import type { Skill, SortKey, SortDir } from '../types'
import HealthBadge from './HealthBadge'
import InsightBadge from './InsightBadge'
import ToggleSwitch from './ToggleSwitch'

interface Props {
  skills: Skill[]
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: SortKey) => void
  selected: Skill | null
  onSelect: (skill: Skill) => void
  onToggle: (skill: Skill, enabled: boolean) => void
  onBreakdown: (skill: Skill) => void
}

const TYPE_LABELS: Record<string, string> = {
  skill: 'skill',
  command: 'cmd',
  subagent: 'subagent',
}

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: 'health', label: 'Health' },
  { key: 'insight', label: 'Diag' },
  { key: 'name', label: 'Name' },
  { key: 'type', label: 'Type' },
  { key: 'scope', label: 'Context' },
  { key: 'lastModified', label: 'Modified' },
  { key: 'activeDollars', label: 'Active $', numeric: true },
  { key: 'loadedDollars', label: 'Loaded $', numeric: true },
  { key: 'totalDollars', label: 'Total $', numeric: true },
]

function fmtDollars(n: number): string {
  return '$' + n.toFixed(4)
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function projectLabel(projectId: string): string {
  // projectId is now the cwd path (/Users/foo/myproject) — grab the last segment.
  // Falls back gracefully for the old dash-encoded hash format.
  return projectId.split('/').filter(Boolean).pop() ?? projectId
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
  skills, sortKey, sortDir, onSort, selected, onSelect, onToggle, onBreakdown,
}: Props) {
  return (
    <div className="table-wrap">
      <table className="inventory-table">
        <thead>
          <tr>
            {COLUMNS.map(col => (
              <th
                key={col.key}
                className={[
                  `col-${col.key}`,
                  sortKey === col.key ? 'sorted' : '',
                  col.numeric ? 'col-numeric' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => onSort(col.key)}
              >
                {col.label}
                {sortKey === col.key && (
                  <span className="sort-arrow">{sortDir === 'asc' ? ' ▲' : ' ▼'}</span>
                )}
              </th>
            ))}
            <th className="col-enabled">Enabled</th>
          </tr>
        </thead>
        <tbody>
          {skills.map(skill => (
            <tr
              key={skill.id}
              className={[
                selected?.id === skill.id ? 'selected' : '',
                skill.disabled ? 'row-disabled' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => onSelect(skill)}
            >
              <td className="col-health">
                <HealthBadge health={skill.health} />
              </td>
              <td className="col-insight">
                <InsightBadge
                  insight={skill.insight}
                  dormant={skill.dormant}
                  activeDollars={skill.activeDollars}
                  loadedDollars={skill.loadedDollars}
                  lastInvoked={skill.lastInvoked}
                />
              </td>
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
              <td className="col-activeDollars col-numeric">
                <span
                  className="dollar-link"
                  onClick={e => { e.stopPropagation(); onBreakdown(skill) }}
                  title="Show cost breakdown"
                >
                  {fmtDollars(skill.activeDollars)}
                </span>
              </td>
              <td className="col-loadedDollars col-numeric">
                <span
                  className="dollar-link"
                  onClick={e => { e.stopPropagation(); onBreakdown(skill) }}
                  title="Show cost breakdown"
                >
                  {fmtDollars(skill.loadedDollars)}
                </span>
              </td>
              <td className="col-totalDollars col-numeric">
                <span
                  className="dollar-link"
                  onClick={e => { e.stopPropagation(); onBreakdown(skill) }}
                  title="Show cost breakdown"
                >
                  {fmtDollars(skill.totalDollars)}
                </span>
              </td>
              <td className="col-enabled" onClick={e => e.stopPropagation()}>
                <ToggleSwitch
                  checked={!skill.disabled}
                  onChange={enabled => onToggle(skill, enabled)}
                  title={skill.disabled ? 'Enable skill' : 'Disable skill'}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

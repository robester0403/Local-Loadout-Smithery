import type { Skill, SortKey, SortDir, Timeframe } from '../types'
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
  timeframe?: Timeframe
  selectedIds?: Set<string>
  onSelectId?: (id: string, checked: boolean) => void
  onSelectAll?: (checked: boolean) => void
}

function tfLabel(tf: Timeframe): string {
  const labels: Record<Timeframe, string> = {
    day: '24h', week: '7d', month: '30d', quarter: '90d', year: '1y', all: '',
  }
  return labels[tf]
}

const TYPE_LABELS: Record<string, string> = {
  skill: 'skill',
  command: 'cmd',
  subagent: 'subagent',
}

const BASE_COLUMNS: { key: SortKey; labelBase: string; numeric?: boolean }[] = [
  { key: 'health', labelBase: 'Health' },
  { key: 'insight', labelBase: 'Diag' },
  { key: 'name', labelBase: 'Name' },
  { key: 'type', labelBase: 'Type' },
  { key: 'scope', labelBase: 'Context' },
  { key: 'lastModified', labelBase: 'Modified' },
  { key: 'activeDollars', labelBase: 'Active $', numeric: true },
  { key: 'loadedDollars', labelBase: 'Loaded $', numeric: true },
  { key: 'totalDollars', labelBase: 'Total $', numeric: true },
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
  skills, sortKey, sortDir, onSort, selected, onSelect, onToggle, onBreakdown, timeframe,
  selectedIds, onSelectId, onSelectAll,
}: Props) {
  const suffix = timeframe ? tfLabel(timeframe) : ''
  const COLUMNS = BASE_COLUMNS.map(col => {
    const isDollar = col.key === 'activeDollars' || col.key === 'loadedDollars' || col.key === 'totalDollars'
    const label = isDollar && suffix ? `${col.labelBase} (${suffix})` : col.labelBase
    return { ...col, label }
  })

  const allChecked = skills.length > 0 && skills.every(s => selectedIds?.has(s.id))
  const someChecked = !allChecked && skills.some(s => selectedIds?.has(s.id))

  return (
    <div className="table-wrap">
      <table className="inventory-table">
        <thead>
          <tr>
            <th className="col-check" onClick={e => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={allChecked}
                ref={el => { if (el) el.indeterminate = someChecked }}
                onChange={e => onSelectAll?.(e.target.checked)}
                title="Select all"
              />
            </th>
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
                selectedIds?.has(skill.id) ? 'row-checked' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => onSelect(skill)}
            >
              <td className="col-check" onClick={e => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selectedIds?.has(skill.id) ?? false}
                  onChange={e => onSelectId?.(skill.id, e.target.checked)}
                />
              </td>
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
                  bloat={skill.bloat}
                  descLen={skill.descLen}
                  suggestedType={skill.suggestedType}
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

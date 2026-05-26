import { IconAlertOctagonFilled, IconAlertTriangle, IconX } from '@tabler/icons-react'
import type { Filters } from '../types'

interface Props {
  filters: Filters
  setFilters: (f: Filters) => void
}

type FilterGroup = {
  label: string
  key: 'type' | 'scope'
  options: string[]
}

const GROUPS: FilterGroup[] = [
  { label: 'Type', key: 'type', options: ['skill', 'command', 'subagent', 'rule', 'mcp'] },
  { label: 'Context', key: 'scope', options: ['global', 'project'] },
]

export default function FilterBar({ filters, setFilters }: Props) {
  function toggle(key: 'type' | 'scope', value: string) {
    const current = filters[key]
    const next = current.includes(value)
      ? current.filter(v => v !== value)
      : [...current, value]
    setFilters({ ...filters, [key]: next })
  }

  function clearAll() {
    setFilters({ type: [], scope: [], issuesOnly: false, reviewOnly: false })
  }

  const hasActive = filters.type.length > 0 || filters.scope.length > 0 || filters.issuesOnly || filters.reviewOnly

  return (
    <div className="filter-bar">
      {GROUPS.map(g => (
        <div key={g.key} className="filter-group">
          <span className="filter-label">{g.label}</span>
          <div className="filter-pills">
            {g.options.map(opt => (
              <button
                key={opt}
                className={`pill ${filters[g.key].includes(opt) ? 'active' : ''}`}
                onClick={() => toggle(g.key, opt)}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div className="filter-group">
        <span className="filter-label">Health</span>
        <div className="filter-pills">
          <button
            className={`pill pill-issues ${filters.issuesOnly ? 'active' : ''}`}
            onClick={() => setFilters({ ...filters, issuesOnly: !filters.issuesOnly })}
          >
            <IconAlertTriangle size={12} stroke={1.75} aria-hidden /> Issues only
          </button>
        </div>
      </div>

      <div className="filter-group">
        <span className="filter-label">Diagnose</span>
        <div className="filter-pills">
          <button
            className={`pill pill-review ${filters.reviewOnly ? 'active' : ''}`}
            onClick={() => setFilters({ ...filters, reviewOnly: !filters.reviewOnly })}
          >
            <IconAlertOctagonFilled size={12} aria-hidden /> Needs review
          </button>
        </div>
      </div>

      {hasActive && (
        <button className="clear-filters" onClick={clearAll}>
          <IconX size={12} stroke={1.75} aria-hidden /> Clear filters
        </button>
      )}
    </div>
  )
}

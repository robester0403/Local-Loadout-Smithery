import type { Filters } from '../types'

interface Props {
  filters: Filters
  setFilters: (f: Filters) => void
}

type FilterGroup = {
  label: string
  key: keyof Filters
  options: string[]
}

export default function FilterBar({ filters, setFilters }: Props) {
  const groups: FilterGroup[] = [
    { label: 'Type', key: 'type', options: ['skill', 'command', 'agent'] },
    { label: 'Context', key: 'scope', options: ['global', 'project'] },
  ]

  function toggle(key: keyof Filters, value: string) {
    const current = filters[key]
    const next = current.includes(value)
      ? current.filter(v => v !== value)
      : [...current, value]
    setFilters({ ...filters, [key]: next })
  }

  function clearAll() {
    setFilters({ type: [], scope: [] })
  }

  const hasActive = filters.type.length > 0 || filters.scope.length > 0

  return (
    <div className="filter-bar">
      {groups.map(g => (
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
      {hasActive && (
        <button className="clear-filters" onClick={clearAll}>
          × Clear filters
        </button>
      )}
    </div>
  )
}

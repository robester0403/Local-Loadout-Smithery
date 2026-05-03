import type { Filters } from '../types'

interface Props {
  filters: Filters
  setFilters: (f: Filters) => void
  accounts: string[]
}

type FilterGroup = {
  label: string
  key: keyof Filters
  options: string[]
}

export default function FilterBar({ filters, setFilters, accounts }: Props) {
  const groups: FilterGroup[] = [
    { label: 'Type', key: 'type', options: ['skill', 'command', 'agent'] },
    { label: 'Scope', key: 'scope', options: ['global', 'project'] },
    { label: 'Account', key: 'account', options: accounts },
  ]

  function toggle(key: keyof Filters, value: string) {
    setFilters({ ...filters, [key]: filters[key] === value ? '' : value })
  }

  function clearAll() {
    setFilters({ type: '', scope: '', account: '' })
  }

  const hasActive = filters.type || filters.scope || filters.account

  return (
    <div className="filter-bar">
      {groups.map(g => (
        <div key={g.key} className="filter-group">
          <span className="filter-label">{g.label}</span>
          <div className="filter-pills">
            {g.options.map(opt => (
              <button
                key={opt}
                className={`pill ${filters[g.key] === opt ? 'active' : ''}`}
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

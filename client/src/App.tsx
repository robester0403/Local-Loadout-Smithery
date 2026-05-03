import { useState, useEffect, useCallback } from 'react'
import type { Skill, SortKey, SortDir, Filters } from './types'
import { fetchInventory, openSkill } from './api'
import InventoryTable from './components/InventoryTable'
import DetailDrawer from './components/DetailDrawer'
import FilterBar from './components/FilterBar'
import EmptyState from './components/EmptyState'
import './App.css'

export default function App() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Filters>({ type: '', scope: '', account: '' })
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [selected, setSelected] = useState<Skill | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchInventory()
      setSkills(data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = skills
    .filter(s => {
      if (filters.type && s.type !== filters.type) return false
      if (filters.scope && s.scope !== filters.scope) return false
      if (filters.account && s.account !== filters.account) return false
      if (search) {
        const q = search.toLowerCase()
        return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
      }
      return true
    })
    .sort((a, b) => {
      const av = a[sortKey] ?? ''
      const bv = b[sortKey] ?? ''
      const cmp = av < bv ? -1 : av > bv ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })

  const accounts = [...new Set(skills.map(s => s.account))]

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  const counts = {
    skill: skills.filter(s => s.type === 'skill').length,
    command: skills.filter(s => s.type === 'command').length,
    agent: skills.filter(s => s.type === 'agent').length,
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <span className="header-title">Local Skill Manager</span>
          <span className="header-count">{skills.length} total</span>
        </div>
        <div className="header-right">
          <button className="btn btn-sm" onClick={load} disabled={loading}>
            {loading ? '…' : '↺'} Refresh
          </button>
        </div>
      </header>

      <aside className="sidebar">
        <div className="search-wrap">
          <input
            className="search-input"
            type="search"
            placeholder="Search name or description…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <FilterBar filters={filters} setFilters={setFilters} accounts={accounts} />

        <div className="sidebar-stats">
          <div className="stat-row">
            <span className="type-badge type-skill">skill</span>
            <span>{counts.skill}</span>
          </div>
          <div className="stat-row">
            <span className="type-badge type-command">cmd</span>
            <span>{counts.command}</span>
          </div>
          <div className="stat-row">
            <span className="type-badge type-agent">agent</span>
            <span>{counts.agent}</span>
          </div>
        </div>
      </aside>

      <main className="main">
        {loading ? (
          <EmptyState variant="loading" />
        ) : error ? (
          <EmptyState variant="error" message={error} onRetry={load} />
        ) : filtered.length === 0 ? (
          <EmptyState variant="empty" />
        ) : (
          <InventoryTable
            skills={filtered}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            selected={selected}
            onSelect={setSelected}
          />
        )}
      </main>

      {selected && (
        <DetailDrawer
          skill={selected}
          onClose={() => setSelected(null)}
          onOpen={async (skill) => { await openSkill(skill.id) }}
        />
      )}
    </div>
  )
}

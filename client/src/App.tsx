import { useState, useEffect, useCallback } from 'react'
import type { Skill, SortKey, SortDir, Filters } from './types'
import { fetchInventory, openSkill, setSkillDisabled } from './api'
import InventoryTable from './components/InventoryTable'
import DetailDrawer from './components/DetailDrawer'
import FilterBar from './components/FilterBar'
import EmptyState from './components/EmptyState'
import './App.css'

const HEALTH_ORDER: Record<string, number> = { error: 0, warn: 1, ok: 2 }

export default function App() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Filters>({ type: [], scope: [], issuesOnly: false })
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

  useEffect(() => {
    const id = setInterval(async () => {
      try { setSkills(await fetchInventory()) } catch { /* ignore */ }
    }, 30_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!selected) return
    setSelected(prev => prev ? (skills.find(s => s.id === prev.id) ?? null) : null)
  }, [skills])

  async function handleToggle(skill: Skill, enabled: boolean) {
    // Optimistic update
    setSkills(prev => prev.map(s => s.id === skill.id ? { ...s, disabled: !enabled } : s))
    try {
      await setSkillDisabled(skill.id, !enabled)
    } catch {
      // Revert on failure
      setSkills(prev => prev.map(s => s.id === skill.id ? { ...s, disabled: skill.disabled } : s))
    }
  }

  const filtered = skills
    .filter(s => {
      if (filters.type.length > 0 && !filters.type.includes(s.type)) return false
      if (filters.scope.length > 0 && !filters.scope.includes(s.scope)) return false
      if (filters.issuesOnly && s.health.status === 'ok') return false
      if (search) {
        const q = search.toLowerCase()
        return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
      }
      return true
    })
    .sort((a, b) => {
      // Disabled always floats to bottom regardless of sort column
      if (a.disabled !== b.disabled) return a.disabled ? 1 : -1

      let cmp: number
      if (sortKey === 'health') {
        cmp = HEALTH_ORDER[a.health.status] - HEALTH_ORDER[b.health.status]
      } else {
        const av = a[sortKey] ?? ''
        const bv = b[sortKey] ?? ''
        cmp = av < bv ? -1 : av > bv ? 1 : 0
      }
      return sortDir === 'asc' ? cmp : -cmp
    })

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

        <FilterBar filters={filters} setFilters={setFilters} />

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
            onToggle={handleToggle}
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

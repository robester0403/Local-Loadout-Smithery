import { useState, useEffect, useCallback } from 'react'
import type { Skill, SkillUsageSummary, Insight, SortKey, SortDir, Filters, Timeframe } from './types'
import { fetchInventory, fetchUsageAggregate, openSkill as apiOpenSkill, setSkillDisabled } from './api'
import InventoryTable from './components/InventoryTable'
import DetailDrawer from './components/DetailDrawer'
import FilterBar from './components/FilterBar'
import EmptyState from './components/EmptyState'
import CostExplainerModal from './components/CostExplainerModal'
import CostBreakdownPanel from './components/CostBreakdownPanel'
import TimeframePicker from './components/TimeframePicker'
import './App.css'

// Thresholds for diagnostic insights.
// Future: read from ~/.local-skill-manager/config.json
const LOADED_HIGH_USD = 0.001   // skills costing > $0.001 in loaded context are "high loaded"
const ACTIVE_HIGH_USD = 0.0001  // treat active < $0.0001 as "zero active" (float safety)
const DORMANT_DAYS = 90
const GRACE_PERIOD_DAYS = 10    // newly modified skills are exempt from removal-candidate flag

const HEALTH_ORDER: Record<string, number> = { error: 0, warn: 1, ok: 2 }
const INSIGHT_RANK = (s: Skill): number =>
  s.insight === 'removal-candidate' ? 0 : s.dormant ? 1 : s.insight === 'winner' ? 2 : 3

function mergeWithCost(skills: Skill[], summaries: SkillUsageSummary[]): Skill[] {
  const costMap = new Map(summaries.map(s => [s.skillName, s]))
  const now = Date.now()
  return skills.map(s => {
    const c = costMap.get(s.name)
    const activeDollars = c?.active.dollars ?? 0
    const loadedDollars = c?.loaded.dollars ?? 0
    const totalDollars = c?.total.dollars ?? 0

    const isNew = (now - new Date(s.lastModified).getTime()) / 86_400_000 < GRACE_PERIOD_DAYS

    let insight: Insight = null
    if (loadedDollars >= LOADED_HIGH_USD) {
      if (activeDollars >= ACTIVE_HIGH_USD) {
        insight = 'winner'
      } else if (!isNew) {
        insight = 'removal-candidate'
      }
    }

    const dormant = !!(
      c?.lastInvoked &&
      (now - new Date(c.lastInvoked).getTime()) / 86_400_000 > DORMANT_DAYS
    )

    const descLen = s.description.length
    const bloat = s.type !== 'command' && descLen > 150

    return { ...s, activeDollars, loadedDollars, totalDollars, insight, dormant, lastInvoked: c?.lastInvoked ?? '', bloat, descLen }
  })
}

export default function App() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Filters>({ type: [], scope: [], issuesOnly: false, reviewOnly: false })
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [selected, setSelected] = useState<Skill | null>(null)
  const [showCostModal, setShowCostModal] = useState(false)
  const [breakdownSkill, setBreakdownSkill] = useState<Skill | null>(null)
  const [timeframe, setTimeframe] = useState<Timeframe>(
    () => (localStorage.getItem('lsm-timeframe') as Timeframe) ?? 'all'
  )

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3500)
  }

  useEffect(() => {
    localStorage.setItem('lsm-timeframe', timeframe)
  }, [timeframe])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rawSkills = await fetchInventory()
      let summaries: SkillUsageSummary[] = []
      try { summaries = await fetchUsageAggregate(timeframe) } catch { /* cost data unavailable */ }
      setSkills(mergeWithCost(rawSkills, summaries))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [timeframe])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const rawSkills = await fetchInventory()
        let summaries: SkillUsageSummary[] = []
        try { summaries = await fetchUsageAggregate(timeframe) } catch { /* ignore */ }
        setSkills(mergeWithCost(rawSkills, summaries))
      } catch { /* ignore */ }
    }, 30_000)
    return () => clearInterval(id)
  }, [timeframe])

  useEffect(() => {
    if (!selected) return
    setSelected(prev => prev ? (skills.find(s => s.id === prev.id) ?? null) : null)
  }, [skills])

  async function handleToggle(skill: Skill, enabled: boolean) {
    setSkills(prev => prev.map(s => s.id === skill.id ? { ...s, disabled: !enabled } : s))
    try {
      await setSkillDisabled(skill.id, !enabled)
    } catch (e) {
      setSkills(prev => prev.map(s => s.id === skill.id ? { ...s, disabled: skill.disabled } : s))
      showToast((e as Error).message)
    }
  }

  async function handleOpen(skill: Skill) {
    try {
      await apiOpenSkill(skill.id)
    } catch (e) {
      showToast((e as Error).message)
    }
  }

  const filtered = skills
    .filter(s => {
      if (filters.type.length > 0 && !filters.type.includes(s.type)) return false
      if (filters.scope.length > 0 && !filters.scope.includes(s.scope)) return false
      if (filters.issuesOnly && s.health.status === 'ok') return false
      if (filters.reviewOnly && s.insight !== 'removal-candidate' && !s.dormant) return false
      if (search) {
        const q = search.toLowerCase()
        return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
      }
      return true
    })
    .sort((a, b) => {
      if (a.disabled !== b.disabled) return a.disabled ? 1 : -1

      let cmp: number
      if (sortKey === 'health') {
        cmp = HEALTH_ORDER[a.health.status] - HEALTH_ORDER[b.health.status]
      } else if (sortKey === 'insight') {
        cmp = INSIGHT_RANK(a) - INSIGHT_RANK(b)
      } else if (sortKey === 'activeDollars' || sortKey === 'loadedDollars' || sortKey === 'totalDollars') {
        cmp = (a[sortKey] ?? 0) - (b[sortKey] ?? 0)
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
    subagent: skills.filter(s => s.type === 'subagent').length,
  }

  const removalCount = skills.filter(s => s.insight === 'removal-candidate').length
  const dormantCount = skills.filter(s => s.dormant && s.insight !== 'removal-candidate').length
  const reviewCount = removalCount + dormantCount
  const showBanner = !loading && !error && reviewCount > 0 && !filters.reviewOnly

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <span className="header-title">Local Skill Manager</span>
          <span className="header-count">{skills.length} total</span>
        </div>
        <div className="header-right">
          <TimeframePicker value={timeframe} onChange={setTimeframe} />
          <button className="btn btn-sm" onClick={() => setShowCostModal(true)} title="How cost tracking works">
            ? How costs work
          </button>
          <button className="btn btn-sm" onClick={load} disabled={loading}>
            {loading ? '…' : '↺'} Refresh
          </button>
        </div>
      </header>

      {toast && (
        <div className="toast" role="alert">
          <span>⚠ {toast}</span>
          <button className="toast-dismiss" onClick={() => setToast(null)}>×</button>
        </div>
      )}

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
            <span className="type-badge type-subagent">subagent</span>
            <span>{counts.subagent}</span>
          </div>
        </div>
      </aside>

      <main className="main">
        {showBanner && (
          <div className="insight-banner">
            <span className="insight-banner-text">
              {removalCount > 0 && (
                <span><span className="banner-em">🚨 {removalCount} removal {removalCount === 1 ? 'candidate' : 'candidates'}</span> — loaded but never invoked</span>
              )}
              {removalCount > 0 && dormantCount > 0 && <span className="banner-sep"> · </span>}
              {dormantCount > 0 && (
                <span><span className="banner-em">💤 {dormantCount} dormant</span> — not invoked in {DORMANT_DAYS}+ days</span>
              )}
            </span>
            <button
              className="btn btn-sm btn-warn"
              onClick={() => setFilters(f => ({ ...f, reviewOnly: true }))}
            >
              Review →
            </button>
          </div>
        )}

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
            onBreakdown={setBreakdownSkill}
            timeframe={timeframe}
          />
        )}
      </main>

      {selected && (
        <DetailDrawer
          skill={selected}
          allSkills={skills}
          onClose={() => setSelected(null)}
          onOpen={handleOpen}
          onBreakdown={setBreakdownSkill}
          onSelect={setSelected}
        />
      )}

      {showCostModal && (
        <CostExplainerModal onClose={() => setShowCostModal(false)} timeframe={timeframe} />
      )}

      {breakdownSkill && (
        <CostBreakdownPanel
          skill={breakdownSkill}
          onClose={() => setBreakdownSkill(null)}
          timeframe={timeframe}
        />
      )}
    </div>
  )
}

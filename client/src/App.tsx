import { useState, useEffect, useCallback, useRef } from 'react'
import type { Skill, SkillType, SkillUsageSummary, SortKey, SortDir, Filters, Timeframe, MCPRow } from './types'
import { fetchInventory, fetchUsageAggregate, openSkill as apiOpenSkill, setSkillDisabled, fetchProfiles, createProfile, deleteProfile, activateProfile, launchClaude, reclassifySkill, fetchUninstalled, uninstallSkillApi, restoreSkillApi, fetchMCPInventory, fetchMCPUsage, fetchMCPRelationships } from './api'
import type { ProfilesData, UninstalledEntry, MCPUsageSummary, MCPRelationship } from './api'
import {
  DORMANT_DAYS,
  HEALTH_ORDER,
  INSIGHT_RANK,
  computeTotals,
  countReview,
  fmtUsd,
  mergeWithCost,
  toMCPSkill,
} from './lib/cost'
import { getBundledPrompt } from './prompts'
import InventoryTable from './components/InventoryTable'
import DetailDrawer from './components/DetailDrawer'
import FilterBar from './components/FilterBar'
import EmptyState from './components/EmptyState'
import CostExplainerModal from './components/CostExplainerModal'
import ProfileSwitcher from './components/ProfileSwitcher'
import CostBreakdownPanel from './components/CostBreakdownPanel'
import TimeframePicker from './components/TimeframePicker'
import SuperRouterTab from './components/SuperRouterTab'
import UninstalledPanel from './components/UninstalledPanel'
import './App.css'

type ActiveTab = 'inventory' | 'superrouter'

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
    () => (localStorage.getItem('loadoutsmith-timeframe') as Timeframe)
      ?? (localStorage.getItem('lsm-timeframe') as Timeframe)  // legacy key from pre-rename builds
      ?? 'all'
  )
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [profilesData, setProfilesData] = useState<ProfilesData>({ profiles: {}, activeProfile: null })
  const [lastMove, setLastMove] = useState<{ newId: string; originalType: SkillType; skillName: string } | null>(null)
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [activeTab, setActiveTab] = useState<ActiveTab>('inventory')
  const [trashCount, setTrashCount] = useState(0)
  const [showTrash, setShowTrash] = useState(false)
  const [lastUninstall, setLastUninstall] = useState<{ id: string; name: string } | null>(null)
  const uninstallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [mcpUsageMap, setMcpUsageMap] = useState<Map<string, MCPUsageSummary>>(new Map())
  const [mcpRelationships, setMcpRelationships] = useState<MCPRelationship[]>([])

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3500)
  }

  useEffect(() => {
    localStorage.setItem('loadoutsmith-timeframe', timeframe)
  }, [timeframe])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [rawSkills, pd, uninstalled, mcpServers, mcpUsage, mcpRels] = await Promise.all([
        fetchInventory(),
        fetchProfiles().catch(() => ({ profiles: {}, activeProfile: null })),
        fetchUninstalled().catch(() => [] as UninstalledEntry[]),
        fetchMCPInventory().catch(() => [] as MCPRow[]),
        fetchMCPUsage(timeframe).catch(() => [] as MCPUsageSummary[]),
        fetchMCPRelationships().catch(() => [] as MCPRelationship[]),
      ])
      let summaries: SkillUsageSummary[] = []
      try { summaries = await fetchUsageAggregate(timeframe) } catch { /* cost data unavailable */ }
      const merged = mergeWithCost(rawSkills, summaries)
      const usageMap = new Map(mcpUsage.map(u => [u.serverName, u]))
      setMcpUsageMap(usageMap)
      setMcpRelationships(mcpRels)
      setSkills([...merged, ...mcpServers.map(e => toMCPSkill(e, usageMap.get(e.name)))])
      setProfilesData(pd)
      setTrashCount(uninstalled.length)
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
        const [rawSkills, pd, mcpServers, mcpUsage, mcpRels] = await Promise.all([
          fetchInventory(),
          fetchProfiles().catch(() => null),
          fetchMCPInventory().catch(() => [] as MCPRow[]),
          fetchMCPUsage(timeframe).catch(() => [] as MCPUsageSummary[]),
          fetchMCPRelationships().catch(() => [] as MCPRelationship[]),
        ])
        let summaries: SkillUsageSummary[] = []
        try { summaries = await fetchUsageAggregate(timeframe) } catch { /* ignore */ }
        const merged = mergeWithCost(rawSkills, summaries)
        const usageMap = new Map(mcpUsage.map(u => [u.serverName, u]))
        setMcpUsageMap(usageMap)
        setMcpRelationships(mcpRels)
        setSkills([...merged, ...mcpServers.map(e => toMCPSkill(e, usageMap.get(e.name)))])
        if (pd) setProfilesData(pd)
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

  function handleSelectId(id: string, checked: boolean) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function handleSelectAll(checked: boolean) {
    setSelectedIds(checked ? new Set(filtered.map(s => s.id)) : new Set())
  }

  async function handleBulkDisable() {
    const targets = filtered.filter(s => selectedIds.has(s.id) && !s.disabled)
    if (targets.length === 0) return
    if (targets.length > 5) {
      if (!window.confirm(`Disable ${targets.length} skills? This can be undone one by one via the toggle.`)) return
    }
    setSkills(prev => prev.map(s => selectedIds.has(s.id) ? { ...s, disabled: true } : s))
    setSelectedIds(new Set())
    const errors: string[] = []
    await Promise.all(targets.map(async s => {
      try { await setSkillDisabled(s.id, true) }
      catch (e) { errors.push(s.name) }
    }))
    if (errors.length > 0) {
      showToast(`Failed to disable: ${errors.join(', ')}`)
      await load()
    }
  }

  async function handleActivateProfile(name: string | null) {
    try {
      await activateProfile(name)
      await load()
    } catch (e) {
      showToast((e as Error).message)
    }
  }

  async function handleCreateProfile(name: string, skillIds: string[]) {
    try {
      await createProfile(name, skillIds)
      const pd = await fetchProfiles()
      setProfilesData(pd)
    } catch (e) {
      showToast((e as Error).message)
    }
  }

  async function handleDeleteProfile(name: string) {
    try {
      await deleteProfile(name)
      const pd = await fetchProfiles()
      setProfilesData(pd)
      await load()
    } catch (e) {
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

  async function handleReclassify(skill: Skill) {
    if (!skill.suggestedType) return
    const { suggested } = skill.suggestedType
    if (!window.confirm(
      `Move "${skill.name}" from ${skill.type} → ${suggested}?\n\nThe file will be moved to the ${suggested}s directory. You can undo this for 60 seconds.`,
    )) return
    try {
      const result = await reclassifySkill(skill.id, suggested)
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
      setLastMove({ newId: result.newId, originalType: skill.type, skillName: skill.name })
      undoTimerRef.current = setTimeout(() => setLastMove(null), 60_000)
      showToast(`${skill.name} moved to ${suggested}s`)
      await load()
    } catch (e) {
      showToast((e as Error).message)
    }
  }

  async function handleUndoMove() {
    if (!lastMove) return
    try {
      await reclassifySkill(lastMove.newId, lastMove.originalType)
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
      setLastMove(null)
      showToast(`${lastMove.skillName} move undone`)
      await load()
    } catch (e) {
      showToast((e as Error).message)
    }
  }

  async function handleUninstall(skill: Skill) {
    if (!window.confirm(
      `Uninstall "${skill.name}"?\n\nThe skill will be moved to Trash and can be restored from there.`,
    )) return
    try {
      await uninstallSkillApi(skill.id)
      setSelected(null)
      if (uninstallTimerRef.current) clearTimeout(uninstallTimerRef.current)
      setLastUninstall({ id: skill.id, name: skill.name })
      uninstallTimerRef.current = setTimeout(() => setLastUninstall(null), 60_000)
      setTrashCount(c => c + 1)
      showToast(`${skill.name} uninstalled`)
      await load()
    } catch (e) {
      showToast((e as Error).message)
    }
  }

  async function handleUninstallUndo() {
    if (!lastUninstall) return
    try {
      await restoreSkillApi(lastUninstall.id)
      if (uninstallTimerRef.current) clearTimeout(uninstallTimerRef.current)
      setLastUninstall(null)
      setTrashCount(c => Math.max(0, c - 1))
      showToast(`${lastUninstall.name} restored`)
      await load()
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
      // Note: we intentionally do NOT push disabled rows to the bottom here.
      // Toggling a skill should be a quiet, in-place state change — shoving the
      // row to the end of the list creates a jarring shift and loses the user's
      // place. The .row-disabled style already makes disabled rows visually
      // distinct; users who want them grouped can sort by an explicit column.

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
    mcp: skills.filter(s => s.type === 'mcp').length,
  }

  const totals = computeTotals(skills)
  const review = countReview(skills)
  const showBanner = !loading && !error && review.total > 0 && !filters.reviewOnly

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <span className="header-title">Local Loadout Smithery</span>
          <span className="header-motto">Win little and win big</span>
          <span className="header-count">{skills.length} total</span>
          <span className="header-cost" title={`Active ${fmtUsd(totals.active)} · Loaded ${fmtUsd(totals.loaded)} (${totals.total > 0 ? Math.round((totals.loaded / totals.total) * 100) : 0}% of total)`}>
            <span className="header-cost-label">Total</span>
            <span className="header-cost-value">{fmtUsd(totals.total)}</span>
            <span className="header-cost-split">
              <span className="header-cost-active">A {fmtUsd(totals.active)}</span>
              <span className="header-cost-sep">·</span>
              <span className="header-cost-loaded">
                L {fmtUsd(totals.loaded)}
                {totals.total > 0 && (
                  <span className="header-cost-pct"> ({Math.round((totals.loaded / totals.total) * 100)}%)</span>
                )}
              </span>
            </span>
          </span>
        </div>
        <div className="header-tabs">
          <button
            className={`header-tab${activeTab === 'inventory' ? ' active' : ''}`}
            onClick={() => setActiveTab('inventory')}
          >Inventory</button>
          <button
            className={`header-tab${activeTab === 'superrouter' ? ' active' : ''}`}
            onClick={() => setActiveTab('superrouter')}
          >SuperRouter</button>
        </div>

        <div className="header-right">
          <ProfileSwitcher
            profilesData={profilesData}
            allSkillIds={skills.map(s => s.id)}
            onActivate={handleActivateProfile}
            onCreate={handleCreateProfile}
            onDelete={handleDeleteProfile}
          />
          <TimeframePicker value={timeframe} onChange={setTimeframe} />
          <button className="btn btn-sm" onClick={() => setShowCostModal(true)} title="How cost tracking works">
            ? How costs work
          </button>
          {lastUninstall && (
            <button className="btn btn-sm btn-warn" onClick={handleUninstallUndo} title={`Restore ${lastUninstall.name}`}>
              ↩ Restore: {lastUninstall.name}
            </button>
          )}
          {lastMove && (
            <button className="btn btn-sm btn-warn" onClick={handleUndoMove} title={`Undo move of ${lastMove.skillName}`}>
              ↩ Undo: {lastMove.skillName}
            </button>
          )}
          <button
            className={`btn btn-sm${trashCount > 0 ? ' btn-trash-active' : ''}`}
            onClick={() => setShowTrash(true)}
            title="View uninstalled skills"
          >
            🗑{trashCount > 0 ? ` ${trashCount}` : ' Trash'}
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
          <div className="stat-row">
            <span className="type-badge type-mcp">mcp</span>
            <span>{counts.mcp}</span>
          </div>
        </div>
      </aside>

      <main className="main">
        {activeTab === 'superrouter' ? (
          <SuperRouterTab skills={skills} onToast={showToast} />
        ) : (
          <>
            {showBanner && (
              <div className="insight-banner">
                <span className="insight-banner-text">
                  {review.removal > 0 && (
                    <span><span className="banner-em">🚨 {review.removal} removal {review.removal === 1 ? 'candidate' : 'candidates'}</span> — loaded but never invoked</span>
                  )}
                  {review.removal > 0 && review.dormant > 0 && <span className="banner-sep"> · </span>}
                  {review.dormant > 0 && (
                    <span><span className="banner-em">💤 {review.dormant} dormant</span> — not invoked in {DORMANT_DAYS}+ days</span>
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

            {selectedIds.size > 0 && (
              <div className="bulk-bar">
                <span className="bulk-count">{selectedIds.size} selected</span>
                <button className="btn btn-sm" onClick={async () => {
                  const targets = filtered.filter(s => selectedIds.has(s.id))
                  const prompt = getBundledPrompt(targets)
                  try {
                    const result = await launchClaude(prompt)
                    showToast(result.platform === 'unsupported'
                      ? 'Prompt copied — open Claude Code manually'
                      : 'Prompt copied + Claude Code launched')
                  } catch {
                    await navigator.clipboard.writeText(prompt)
                    showToast('Prompt copied to clipboard')
                  }
                }}>
                  Generate combined prompt
                </button>
                <button className="btn btn-sm btn-warn" onClick={handleBulkDisable}>
                  Disable selected
                </button>
                <button className="btn btn-sm" onClick={() => setSelectedIds(new Set())}>
                  Clear
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
                selectedIds={selectedIds}
                onSelectId={handleSelectId}
                onSelectAll={handleSelectAll}
                onReclassify={handleReclassify}
              />
            )}
          </>
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
          onReclassify={handleReclassify}
          onUninstall={handleUninstall}
          mcpUsageMap={mcpUsageMap}
          mcpRelationships={mcpRelationships}
        />
      )}

      {showTrash && (
        <UninstalledPanel
          onClose={() => setShowTrash(false)}
          onRestored={load}
          onCountChange={setTrashCount}
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

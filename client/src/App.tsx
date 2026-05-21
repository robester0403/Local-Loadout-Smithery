import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { Skill, SkillType, SkillUsageSummary, SortKey, SortDir, Filters, Timeframe, MCPRow } from './types'
import { fetchInventory, fetchUsageAggregate, openSkill as apiOpenSkill, setSkillDisabled, fetchProfiles, createProfile, deleteProfile, activateProfile, launchClaude, reclassifySkill, fetchUninstalled, uninstallSkillApi, restoreSkillApi, fetchMCPInventory, fetchMCPUsage, fetchMCPRelationships } from './api'
import type { ProfilesData, UninstalledEntry, MCPUsageSummary, MCPRelationship } from './api'
import {
  HEALTH_ORDER,
  INSIGHT_RANK,
  computeTotals,
  countReview,
  fmtUsd,
  mergeWithCost,
  reapplyThresholds,
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
import UninstalledPanel from './components/UninstalledPanel'
import CursorTab from './components/CursorTab'
import CodexTab from './components/CodexTab'
import BundleEditorModal from './components/BundleEditorModal'
import SuperRouterPanel from './components/SuperRouterPanel'
import AutoSkillPanel from './components/AutoSkillPanel'
import SettingsPanel from './components/SettingsPanel'
import { useSettings } from './hooks/useSettings'
import { fetchBundles, type Bundle } from './api'
import { fetchCursorUsage, fetchCursorRecentUsage, rescanCursorProjects, type CursorUsageReport, type CursorRecentUsageReport } from './api'
import {
  IconAlertOctagonFilled,
  IconAlertTriangle,
  IconArrowBackUp,
  IconChevronLeft,
  IconChevronRight,
  IconHelp,
  IconRefresh,
  IconRoute,
  IconSearch,
  IconSparkles,
  IconTrash,
  IconX,
  IconZzz,
} from '@tabler/icons-react'
import './App.css'

type ActiveTab = 'inventory' | 'cursor' | 'codex'

// Safety net for the tab-aware loaders: if the server ever returns the same
// skill in both the Claude and Cursor responses (e.g. an old build that
// doesn't yet support `?ecosystem=`), we'd otherwise render duplicates. Keep
// the first occurrence of each id and drop the rest.
function dedupById(skills: Skill[]): Skill[] {
  const seen = new Set<string>()
  const out: Skill[] = []
  for (const s of skills) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    out.push(s)
  }
  return out
}

export default function App() {
  const settings = useSettings()
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [rescanning, setRescanning] = useState(false)
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
  // Sidebar collapse state. Persisted across reloads via localStorage so the
  // user's layout choice survives — same pattern as the `loadoutsmith-timeframe`
  // preference above.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    () => localStorage.getItem('loadoutsmith-sidebar-collapsed') === '1',
  )
  useEffect(() => {
    localStorage.setItem('loadoutsmith-sidebar-collapsed', sidebarCollapsed ? '1' : '0')
  }, [sidebarCollapsed])
  const [trashCount, setTrashCount] = useState(0)
  const [showTrash, setShowTrash] = useState(false)
  const [lastUninstall, setLastUninstall] = useState<{ id: string; name: string } | null>(null)
  const uninstallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [mcpUsageMap, setMcpUsageMap] = useState<Map<string, MCPUsageSummary>>(new Map())
  const [mcpRelationships, setMcpRelationships] = useState<MCPRelationship[]>([])
  const [cursorUsage, setCursorUsage] = useState<CursorUsageReport | null>(null)
  const [cursorRecent, setCursorRecent] = useState<CursorRecentUsageReport | null>(null)
  const [showBundlesPanel, setShowBundlesPanel] = useState(false)
  const [showBundleEditor, setShowBundleEditor] = useState(false)
  const [bundleCount, setBundleCount] = useState(0)
  const [showAutoSkill, setShowAutoSkill] = useState(false)

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3500)
  }

  // Wraps an async operation so its rejection surfaces as a toast. Returns the
  // value on success, undefined on failure — callers that need to branch can
  // check the return.
  async function runOrToast<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn()
    } catch (e) {
      showToast((e as Error).message)
      return undefined
    }
  }

  useEffect(() => {
    localStorage.setItem('loadoutsmith-timeframe', timeframe)
  }, [timeframe])

  // Tab-scoped loader. Each ecosystem owns its slice of `skills` (keyed by
  // account) plus its tab-specific side channels (profiles+MCP for Claude,
  // usage/recent for Cursor). Splitting by ecosystem means a refresh on one
  // tab never re-scans the others, which dominates scan time.

  // The loader intentionally does NOT depend on thresholds — that would
  // trigger a full server refetch (and spinner flicker) on every Settings
  // edit. The `viewSkills` memo below applies thresholds at render time over
  // whatever the loader has populated, so changes reclassify instantly
  // without I/O.
  const thresholds = settings.thresholds

  type Ecosystem = 'claude' | 'cursor' | 'codex'

  const loadBundle = useCallback(async (ecosystem: Ecosystem): Promise<void> => {
    if (ecosystem === 'claude') {
      const [rawSkills, pd, uninstalled, mcpServers, mcpUsage, mcpRels] = await Promise.all([
        fetchInventory('claude'),
        fetchProfiles().catch(() => null),
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
      const mcp = mcpServers.map(e => toMCPSkill(e, usageMap.get(e.name)))
      // Replace only the Claude+MCP slice; preserve any Cursor or Codex
      // entries already loaded so switching tabs doesn't blank the others.
      setSkills(prev => dedupById([
        ...prev.filter(s => s.account === 'cursor' || s.account === 'codex'),
        ...merged,
        ...mcp,
      ]))
      if (pd) setProfilesData(pd)
      setTrashCount(uninstalled.length)
      return
    }

    if (ecosystem === 'cursor') {
      const [cursorSkills, cursorReport, cursorRecentReport] = await Promise.all([
        fetchInventory('cursor').catch(() => [] as Skill[]),
        fetchCursorUsage().catch((): CursorUsageReport => ({
          available: false, skills: [], totalActivations: 0, distinctSessions: 0,
        })),
        fetchCursorRecentUsage().catch((): CursorRecentUsageReport => ({
          hasData: false, trackingSince: 0, items: [], totalEvents: 0,
        })),
      ])
      setCursorUsage(cursorReport)
      setCursorRecent(cursorRecentReport)
      // Even though Cursor skills have no Claude Code cost data, they need to
      // pass through mergeWithCost so the derived fields (activeDollars,
      // loadedDollars, insight, dormant, bloat, descLen) are populated.
      // Without this the InventoryTable crashes on `undefined.toFixed(...)`.
      const merged = mergeWithCost(cursorSkills, [])
      setSkills(prev => dedupById([
        ...prev.filter(s => s.account !== 'cursor'),
        ...merged,
      ]))
      return
    }

    // Codex — no usage / recent reports because Codex doesn't expose a
    // per-skill activation signal. Discovery + mergeWithCost for derived-
    // field population (same reason as Cursor) and we're done.
    const codexSkills = await fetchInventory('codex').catch(() => [] as Skill[])
    const merged = mergeWithCost(codexSkills, [])
    setSkills(prev => dedupById([
      ...prev.filter(s => s.account !== 'codex'),
      ...merged,
    ]))
  }, [timeframe])

  // 'inventory' tab maps to the Claude ecosystem; the other two are 1:1.
  const tabEcosystem: Ecosystem =
    activeTab === 'cursor' ? 'cursor' : activeTab === 'codex' ? 'codex' : 'claude'

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      await Promise.all([loadBundle('claude'), loadBundle('cursor'), loadBundle('codex')])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [loadBundle])

  useEffect(() => { load() }, [load])

  // `viewSkills` is the threshold-applied view of `skills`. We re-derive at
  // render time rather than syncing into state via an effect — that would
  // cascade renders and fight React's data flow. The loaders also pass
  // thresholds into mergeWithCost so the initial paint already reflects the
  // current settings; this memo handles subsequent live edits without a refetch.
  const flags = settings.flags
  const viewSkills = useMemo(
    () => reapplyThresholds(skills, thresholds, flags),
    [skills, thresholds, flags],
  )

  // Track bundle count for the header badge. Fire-and-forget; failure here
  // just leaves the badge at its previous value.
  useEffect(() => {
    fetchBundles().then(list => setBundleCount(list.length)).catch(() => { })
  }, [])

  // Background refresh — only the active tab's data. Pre-tab-aware version
  // re-scanned everything every 30s; that wasted work on whichever ecosystem
  // the user wasn't currently looking at.
  useEffect(() => {
    const id = setInterval(() => {
      void loadBundle(tabEcosystem).catch(() => { })
    }, 30_000)
    return () => clearInterval(id)
  }, [tabEcosystem, loadBundle])

  useEffect(() => {
    if (!selected) return
    setSelected(prev => prev ? (viewSkills.find(s => s.id === prev.id) ?? null) : null)
  }, [viewSkills])

  async function handleToggle(skill: Skill, enabled: boolean) {
    setSkills(prev => prev.map(s => s.id === skill.id ? { ...s, disabled: !enabled } : s))
    try {
      await setSkillDisabled(skill.id, !enabled)
    } catch (e) {
      setSkills(prev => prev.map(s => s.id === skill.id ? { ...s, disabled: skill.disabled } : s))
      showToast((e as Error).message)
    }
  }

  // Inline description/body edit confirmed by the server. Patch local state
  // immediately so every surface — drawer, rail, table — reflects the change
  // without waiting for the full inventory refetch, then trigger that refetch
  // in the background so derived fields (health, token counts, references)
  // re-resolve canonically.
  // Manual "Rescan projects" — runs the server-side deep filesystem scan,
  // toasts the result, and refreshes the Cursor bundle so any newly-found
  // projects' artifacts appear immediately.
  async function handleCursorRescan() {
    if (rescanning) return
    setRescanning(true)
    try {
      const result = await rescanCursorProjects()
      if (result.addedCount === 0) showToast('No new Cursor projects found.')
      else showToast(`Found ${result.addedCount} new Cursor project${result.addedCount === 1 ? '' : 's'}.`)
      await loadBundle('cursor')
    } catch (e) {
      showToast((e as Error).message)
    } finally {
      setRescanning(false)
    }
  }

  function handleSkillEdited(id: string, patch: { description?: string; body?: string }) {
    setSkills(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s))
    // Reconcile only the ecosystem that owns the edited skill — no need to
    // re-scan the other tree just because we changed a description.
    const edited = skills.find(s => s.id === id)
    if (edited?.account === 'cursor') void loadBundle('cursor').catch(() => { })
    else void loadBundle('claude').catch(() => { })
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
    await runOrToast(async () => {
      await activateProfile(name)
      await load()
    })
  }

  async function handleCreateProfile(name: string, skillIds: string[]) {
    await runOrToast(async () => {
      await createProfile(name, skillIds)
      const pd = await fetchProfiles()
      setProfilesData(pd)
    })
  }

  async function handleDeleteProfile(name: string) {
    await runOrToast(async () => {
      await deleteProfile(name)
      const pd = await fetchProfiles()
      setProfilesData(pd)
      await load()
    })
  }

  async function handleOpen(skill: Skill) {
    await runOrToast(() => apiOpenSkill(skill.id))
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

  // The Cursor tab gets its own table with the same filter/search/sort
  // pipeline. Branch on activeTab so each table sees only its own rows.
  // We filter the threshold-applied view so insight/dormant filters reflect
  // the user's live threshold settings without a refetch.
  //
  // Health-state flags gate the "Issues only" filter: if the user has turned
  // off warn (or error), warn/error rows no longer count as issues. The
  // diag-flag gates already applied at reapplyThresholds time, so the
  // "Needs review" check just consults the post-flag insight/dormant.
  const filtered = viewSkills
    .filter(s => {
      // Three-way ecosystem partition: Cursor tab sees only cursor rows,
      // Codex tab sees only codex rows, Claude tab sees everything else.
      if (activeTab === 'cursor') return s.account === 'cursor'
      if (activeTab === 'codex') return s.account === 'codex'
      return s.account !== 'cursor' && s.account !== 'codex'
    })
    .filter(s => {
      if (filters.type.length > 0 && !filters.type.includes(s.type)) return false
      if (filters.scope.length > 0 && !filters.scope.includes(s.scope)) return false
      if (filters.issuesOnly) {
        const status = s.health.status
        const counts =
          (status === 'warn' && flags.healthWarn) ||
          (status === 'error' && flags.healthError)
        if (!counts) return false
      }
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

  // Scope sidebar counts and review banner to the active tab. The Claude
  // Code tab should not show "5 dormant" if 4 of those are Cursor skills,
  // and vice versa — the two ecosystems don't share a coherent review
  // surface.
  const tabSkills =
    activeTab === 'cursor' ? viewSkills.filter(s => s.account === 'cursor')
    : activeTab === 'codex' ? viewSkills.filter(s => s.account === 'codex')
    : viewSkills.filter(s => s.account !== 'cursor' && s.account !== 'codex')

  const counts = {
    skill: tabSkills.filter(s => s.type === 'skill').length,
    command: tabSkills.filter(s => s.type === 'command').length,
    subagent: tabSkills.filter(s => s.type === 'subagent').length,
    mcp: tabSkills.filter(s => s.type === 'mcp').length,
  }

  const totals = computeTotals(skills)
  const review = countReview(tabSkills)
  // Insight banner is only meaningful on the Claude Code tab — Cursor's
  // activation data is bounded by the persistence fade, and Codex has no
  // activation signal at all, so on those tabs every row would falsely
  // count as a removal candidate or dormant.
  const showBanner = !loading && !error && review.total > 0 && !filters.reviewOnly && activeTab === 'inventory'

  return (
    <div className={`app${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <header className="header">
        <div className="header-left">
          <span className="header-title">Local Loadout Smithery</span>
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
          >Claude Code</button>
          <button
            className={`header-tab${activeTab === 'cursor' ? ' active' : ''}`}
            onClick={() => setActiveTab('cursor')}
            title="Cursor skills + activation data scraped from Cursor's local SQLite"
          >Cursor</button>
          <button
            className={`header-tab${activeTab === 'codex' ? ' active' : ''}`}
            onClick={() => setActiveTab('codex')}
            title="Codex CLI AGENTS.md files — global + per-project (mined from ~/.codex/sessions)"
          >Codex</button>
        </div>

        <div className="header-right">
          <ProfileSwitcher
            profilesData={profilesData}
            allSkillIds={skills.map(s => s.id)}
            onActivate={handleActivateProfile}
            onCreate={handleCreateProfile}
            onDelete={handleDeleteProfile}
          />
          {activeTab === 'inventory' && <TimeframePicker value={timeframe} onChange={setTimeframe} />}
          <button className="btn btn-sm" onClick={() => setShowCostModal(true)} title="How cost tracking works">
            <IconHelp size={14} stroke={1.75} aria-hidden />
            How costs work
          </button>
          {lastUninstall && (
            <button className="btn btn-sm btn-warn" onClick={handleUninstallUndo} title={`Restore ${lastUninstall.name}`}>
              <IconArrowBackUp size={14} stroke={1.75} aria-hidden />
              Restore: {lastUninstall.name}
            </button>
          )}
          {lastMove && (
            <button className="btn btn-sm btn-warn" onClick={handleUndoMove} title={`Undo move of ${lastMove.skillName}`}>
              <IconArrowBackUp size={14} stroke={1.75} aria-hidden />
              Undo: {lastMove.skillName}
            </button>
          )}
          <button
            className={`btn btn-sm${trashCount > 0 ? ' btn-trash-active' : ''}`}
            onClick={() => setShowTrash(true)}
            title="View uninstalled skills"
          >
            <IconTrash size={14} stroke={1.75} aria-hidden />
            {trashCount > 0 ? trashCount : 'Trash'}
          </button>
          <button
            className="btn btn-sm"
            onClick={() => setShowBundlesPanel(true)}
            title="Manage SuperRouter bundles"
          >
            <IconRoute size={14} stroke={1.75} aria-hidden />
            Router{bundleCount > 0 ? ` (${bundleCount})` : ''}
          </button>
          <button
            className="btn btn-sm"
            onClick={() => setShowAutoSkill(true)}
            title="Surface candidate skills from your chat history"
          >
            <IconSparkles size={14} stroke={1.75} aria-hidden />
            Auto Skill
          </button>
          {activeTab === 'cursor' && (
            <button
              className="btn btn-sm"
              onClick={handleCursorRescan}
              disabled={rescanning}
              title="Deep-scan home dir for Cursor projects we haven't seen yet"
            >
              <IconSearch size={14} stroke={1.75} aria-hidden className={rescanning ? 'icon-spin' : undefined} />
              Rescan
            </button>
          )}
          <button
            className="btn btn-sm"
            onClick={() => {
              // Refresh only the active tab's slice; the full `load()` would
              // re-scan all three ecosystems.
              void loadBundle(tabEcosystem).catch(() => { })
            }}
            disabled={loading}
          >
            <IconRefresh size={14} stroke={1.75} aria-hidden className={loading ? 'icon-spin' : undefined} />
            Refresh
          </button>
        </div>
      </header>

      {toast && (
        <div className="toast" role="alert">
          <span className="toast-msg">
            <IconAlertTriangle size={14} stroke={1.75} aria-hidden />
            {toast}
          </span>
          <button className="toast-dismiss" aria-label="Dismiss" onClick={() => setToast(null)}>
            <IconX size={14} stroke={1.75} aria-hidden />
          </button>
        </div>
      )}

      <button
        type="button"
        className="sidebar-collapse-btn"
        onClick={() => setSidebarCollapsed(c => !c)}
        aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!sidebarCollapsed}
        title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {sidebarCollapsed
          ? <IconChevronRight size={16} stroke={2} aria-hidden />
          : <IconChevronLeft size={16} stroke={2} aria-hidden />}
      </button>

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
          {counts.skill > 0 && (
            <div className="stat-row">
              <span className="type-badge type-skill">skill</span>
              <span>{counts.skill}</span>
            </div>
          )}
          {counts.command > 0 && (
            <div className="stat-row">
              <span className="type-badge type-command">cmd</span>
              <span>{counts.command}</span>
            </div>
          )}
          {counts.subagent > 0 && (
            <div className="stat-row">
              <span className="type-badge type-subagent">subagent</span>
              <span>{counts.subagent}</span>
            </div>
          )}
          {counts.mcp > 0 && (
            <div className="stat-row">
              <span className="type-badge type-mcp">mcp</span>
              <span>{counts.mcp}</span>
            </div>
          )}
        </div>

        <SettingsPanel />
      </aside>

      <main className="main">
        {activeTab === 'codex' ? (
          loading ? (
            <EmptyState variant="loading" />
          ) : error ? (
            <EmptyState variant="error" message={error} onRetry={load} />
          ) : (
            <>
              {selectedIds.size > 0 && (
                <div className="bulk-bar">
                  <span className="bulk-count">{selectedIds.size} selected</span>
                  {/* No "Disable selected" or routing-bundle for Codex — we
                      can't toggle AGENTS.md from here, and SuperRouter
                      bundles target Claude/Cursor only. */}
                  <button className="btn btn-sm" onClick={() => setSelectedIds(new Set())}>
                    Clear
                  </button>
                </div>
              )}
              <CodexTab
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
            </>
          )
        ) : activeTab === 'cursor' ? (
          loading ? (
            <EmptyState variant="loading" />
          ) : error ? (
            <EmptyState variant="error" message={error} onRetry={load} />
          ) : (
            <>
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
                  {/* No "Disable selected" — Cursor manages skill activation
                      through its own UI; we can't toggle it from here. */}
                  <button className="btn btn-sm" onClick={() => setShowBundleEditor(true)}>
                    Create routing bundle
                  </button>
                  <button className="btn btn-sm" onClick={() => setSelectedIds(new Set())}>
                    Clear
                  </button>
                </div>
              )}
              <CursorTab
                skills={filtered}
                usage={cursorUsage}
                recent={cursorRecent}
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
            </>
          )
        ) : (
          <>
            {showBanner && (
              <div className="insight-banner">
                <span className="insight-banner-text">
                  {review.removal > 0 && (
                    <span>
                      <span className="banner-em">
                        <IconAlertOctagonFilled size={14} aria-hidden />
                        {review.removal} removal {review.removal === 1 ? 'candidate' : 'candidates'}
                      </span> — loaded but never invoked
                    </span>
                  )}
                  {review.removal > 0 && review.dormant > 0 && <span className="banner-sep"> · </span>}
                  {review.dormant > 0 && (
                    <span>
                      <span className="banner-em">
                        <IconZzz size={14} stroke={1.75} aria-hidden />
                        {review.dormant} dormant
                      </span> — not invoked in {thresholds.dormantDays}+ days
                    </span>
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
                <button className="btn btn-sm" onClick={() => setShowBundleEditor(true)}>
                  Create routing bundle
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
              // No filters + no rows across the entire inventory = nothing
              // installed at all. The plain "empty" variant ("your filters
              // hid everything") is misleading on a fresh machine.
              skills.length === 0 && !search && filters.type.length === 0 && filters.scope.length === 0 && !filters.issuesOnly && !filters.reviewOnly
                ? <EmptyState variant="none-installed" />
                : <EmptyState variant="empty" />
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
          onSkillChanged={handleSkillEdited}
          mcpUsageMap={mcpUsageMap}
          mcpRelationships={mcpRelationships}
          cursorUsage={cursorUsage}
          cursorRecent={cursorRecent}
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

      {showBundlesPanel && (
        <SuperRouterPanel
          allSkills={skills}
          onClose={() => setShowBundlesPanel(false)}
          onCountChange={setBundleCount}
        />
      )}

      {showBundleEditor && (
        <BundleEditorModal
          allSkills={skills}
          initialSkillIds={Array.from(selectedIds)}
          onClose={() => setShowBundleEditor(false)}
          onSaved={(b: Bundle) => {
            setShowBundleEditor(false)
            setSelectedIds(new Set())
            setBundleCount(c => c + 1)
            showToast(`Bundle "${b.name}" created. Open Router to enable it.`)
          }}
        />
      )}

      {showAutoSkill && (
        <AutoSkillPanel
          allSkills={skills}
          onClose={() => setShowAutoSkill(false)}
          onSkillsChanged={() => { void load() }}
        />
      )}
    </div>
  )
}

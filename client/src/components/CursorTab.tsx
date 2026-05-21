// Cursor tab — shows artifacts under ~/.cursor in the same InventoryTable
// the Claude Code tab uses, plus a stats header with activation totals.
//
// The cost columns render activation count + last-used (the Cursor-style
// repurpose) instead of dollars, because Cursor's local SQLite no longer
// carries authoritative tokenCount data. Driven by the `costMode` prop on
// InventoryTable, not by per-row account inspection.

import type { Skill, SortKey, SortDir, Timeframe } from '../types'
import type { CursorUsageReport, CursorRecentUsageReport } from '../api'
import InventoryTable from './InventoryTable'

interface Props {
  skills: Skill[]            // already filtered to cursor account
  usage: CursorUsageReport | null
  recent: CursorRecentUsageReport | null
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
  onReclassify?: (skill: Skill) => void
}

function fmtRelative(ms: number): string {
  if (!ms) return '—'
  const days = Math.floor((Date.now() - ms) / 86_400_000)
  if (days < 0) return 'future'
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

export default function CursorTab(props: Props) {
  const { skills, usage, recent } = props

  if (skills.length === 0 && usage?.available === false) {
    return (
      <div className="cursor-tab-empty">
        <div className="cursor-tab-empty-icon">◌</div>
        <div className="cursor-tab-empty-title">Cursor isn't installed</div>
        <div className="cursor-tab-empty-sub">
          Loadout Smithery looks for skills under <code>~/.cursor/</code> and chat
          activity in <code>~/Library/Application Support/Cursor/</code>. Neither
          was found on this host.
        </div>
      </div>
    )
  }

  if (skills.length === 0) {
    return (
      <div className="cursor-tab-empty">
        <div className="cursor-tab-empty-icon">◌</div>
        <div className="cursor-tab-empty-title">No Cursor skills discovered</div>
        <div className="cursor-tab-empty-sub">
          Add skills under <code>~/.cursor/skills/</code>, commands under{' '}
          <code>~/.cursor/commands/</code>, or agents under{' '}
          <code>~/.cursor/agents/</code>.
        </div>
      </div>
    )
  }

  // Live activity from the local poller — keyed by name (only 'skill' kind
  // here; commands and subagents come through other surfaces).
  const liveByName = new Map<string, { count: number; lastSeen: number }>()
  for (const item of recent?.items ?? []) {
    if (item.kind !== 'skill') continue
    liveByName.set(item.name, { count: item.count, lastSeen: item.lastSeen })
  }

  // Stats line totals: live activity is the user-relevant number now;
  // historical bubble activations get a smaller secondary mention.
  const liveTotal = recent?.totalEvents ?? 0
  const trackingSince = recent?.trackingSince ?? 0
  const historicalTotal = usage?.totalActivations ?? 0

  return (
    <div className="cursor-tab">
      <header className="cursor-tab-header">
        <div className="cursor-tab-stats">
          <span><strong>{skills.length}</strong> artifacts</span>
          <span>
            <strong>{liveTotal}</strong> live activations
            {trackingSince > 0 && (
              <span className="cursor-tab-substat"> (tracking since {fmtRelative(trackingSince)})</span>
            )}
          </span>
          {historicalTotal > 0 && (
            <span>
              <strong>{historicalTotal}</strong> historical
              <span className="cursor-tab-substat"> (from bubble persistence window)</span>
            </span>
          )}
          <span className="cursor-tab-note">
            "Used" / "Last used" reflect activity recorded since LSM started
            polling Cursor's recently-used lists. Skill body and listing token
            sizes (the previous per-turn estimates) are now in the detail
            drawer.
          </span>
        </div>
      </header>

      <InventoryTable {...props} costMode="cursor-live-usage" liveUsage={liveByName} />
    </div>
  )
}

// Cursor tab — shows artifacts under ~/.cursor in the same InventoryTable
// the Claude Code tab uses, plus a stats header with activation totals.
//
// The cost columns render `—` for cursor-account rows (see InventoryTable's
// `isCursor` branch) because Cursor's local SQLite no longer carries
// authoritative tokenCount data.

import type { Skill, SortKey, SortDir, Timeframe } from '../types'
import type { CursorUsageReport } from '../api'
import InventoryTable from './InventoryTable'

interface Props {
  skills: Skill[]            // already filtered to cursor account
  usage: CursorUsageReport | null
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

export default function CursorTab(props: Props) {
  const { skills, usage } = props

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

  // Build per-skill activation lookup from the usage report so the stats line
  // can show how many skills have ever fired.
  const usedNames = new Set(
    (usage?.skills ?? []).filter(u => u.activations > 0).map(u => u.skill),
  )
  const usedCount = skills.filter(s => usedNames.has(s.name)).length
  const totalActivations = usage?.totalActivations ?? 0

  return (
    <div className="cursor-tab">
      <header className="cursor-tab-header">
        <div className="cursor-tab-stats">
          <span><strong>{skills.length}</strong> artifacts</span>
          <span><strong>{usedCount}</strong> used</span>
          <span><strong>{totalActivations}</strong> total activations</span>
          <span className="cursor-tab-note">
            Cursor's local SQLite no longer carries authoritative cost data.
            Cost columns are blank — open a row for activation count.
          </span>
        </div>
      </header>

      <InventoryTable {...props} />
    </div>
  )
}

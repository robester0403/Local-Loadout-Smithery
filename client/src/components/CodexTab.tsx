// Codex tab — shows ~/.codex/AGENTS.md (global) plus per-project AGENTS.md
// files discovered via Codex session metadata. Modeled after CursorTab but
// without the activity-data plumbing — Codex doesn't expose a per-skill
// activation signal, so cost / "last used" columns render `—` (see the
// `isCodex` branch in InventoryTable).

import type { Skill, SortKey, SortDir, Timeframe } from '../types'
import InventoryTable from './InventoryTable'

interface Props {
  skills: Skill[]            // already filtered to codex account
  /**
   * Total Codex skills discovered (unfiltered count). Lets the tab
   * distinguish "no Codex skills installed" from "filters hid everything"
   * — without this, a search query that matches nothing renders the
   * misleading "Codex isn't installed" empty state.
   */
  totalCount: number
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

export default function CodexTab(props: Props) {
  const { skills, totalCount } = props

  if (totalCount === 0) {
    return (
      <div className="cursor-tab-empty">
        <div className="cursor-tab-empty-icon">◌</div>
        <div className="cursor-tab-empty-title">No Codex skills discovered</div>
        <div className="cursor-tab-empty-sub">
          Loadout Smithery looks for a global <code>~/.codex/AGENTS.md</code> and
          per-project <code>&lt;cwd&gt;/AGENTS.md</code> files (project paths come
          from Codex's session metadata under <code>~/.codex/sessions/</code>).
          If Codex isn't installed or you haven't created any AGENTS.md files
          yet, this tab will stay empty.
        </div>
      </div>
    )
  }

  if (skills.length === 0) {
    // Codex IS installed and has skills, but the active search/filter
    // hides them all — distinct from the "no Codex" message above.
    return (
      <div className="cursor-tab-empty">
        <div className="cursor-tab-empty-icon">◌</div>
        <div className="cursor-tab-empty-title">No Codex skills match your filters</div>
        <div className="cursor-tab-empty-sub">
          Try clearing the search or adjusting the filters.
        </div>
      </div>
    )
  }

  return (
    <div className="cursor-tab">
      <header className="cursor-tab-header">
        <div className="cursor-tab-stats">
          <span><strong>{skills.length}</strong> AGENTS.md file{skills.length === 1 ? '' : 's'}</span>
          <span className="cursor-tab-note">
            Codex doesn't expose a per-skill activation signal, so the cost
            columns show "—". Body and listing token sizes are still in the
            detail drawer.
          </span>
        </div>
      </header>

      <InventoryTable {...props} />
    </div>
  )
}

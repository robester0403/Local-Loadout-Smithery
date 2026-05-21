import { IconChevronDown, IconChevronUp } from '@tabler/icons-react'
import type { Skill, SortKey, SortDir, Timeframe } from '../types'
import HealthBadge from './HealthBadge'
import InsightBadge from './InsightBadge'
import ToggleSwitch from './ToggleSwitch'
import { useSettings } from '../hooks/useSettings'
import type { ColumnKey } from '../lib/settings'

interface Props {
  skills: Skill[]
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
  /**
   * When present, indicates this table is rendering the Cursor tab; the cost
   * cells switch to live-usage cells (count + last-used) for cursor rows.
   * Map keys are skill names; entries are absent when a skill has no
   * recorded activations since polling began.
   */
  cursorLiveUsage?: Map<string, { count: number; lastSeen: number }>
}

function tfLabel(tf: Timeframe): string {
  const labels: Record<Timeframe, string> = {
    day: '24h', week: '7d', month: '30d', quarter: '90d', year: '1y', all: '',
  }
  return labels[tf]
}

const TYPE_LABELS: Record<string, string> = {
  skill: 'skill',
  command: 'cmd',
  subagent: 'subagent',
  mcp: 'mcp',
}

// Every column except 'enabled' is sortable, so the keys here overlap with
// SortKey. The settings store uses ColumnKey (which adds 'enabled') — the
// cast at the consumer site is safe because all SortKey values are also
// ColumnKey values.
const BASE_COLUMNS: { key: SortKey; labelBase: string; numeric?: boolean; title?: string }[] = [
  { key: 'health', labelBase: 'Health' },
  { key: 'insight', labelBase: 'Diag' },
  { key: 'name', labelBase: 'Name' },
  { key: 'type', labelBase: 'Type' },
  { key: 'scope', labelBase: 'Context' },
  { key: 'lastModified', labelBase: 'Modified' },
  { key: 'activeDollars', labelBase: 'Active $', numeric: true, title: "Cost of this skill's body sitting in context across turns it was loaded" },
  { key: 'loadedDollars', labelBase: 'Loaded $', numeric: true, title: "Cost of this skill's listing in the system prompt across every turn" },
  { key: 'totalDollars', labelBase: 'Total $', numeric: true },
]

function fmtDollars(n: number): string {
  return '$' + n.toFixed(4)
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

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function projectLabel(projectId: string): string {
  // projectId is now the cwd path (/Users/foo/myproject) — grab the last segment.
  // Falls back gracefully for the old dash-encoded hash format.
  return projectId.split('/').filter(Boolean).pop() ?? projectId
}

function ContextCell({ skill }: { skill: Skill }) {
  if (skill.scope === 'global') {
    return <span className="scope-badge scope-global">global</span>
  }
  const label = skill.projectId ? projectLabel(skill.projectId) : 'project'
  return (
    <span className="scope-badge scope-project" title={skill.projectId}>
      {label}
    </span>
  )
}

export default function InventoryTable({
  skills, sortKey, sortDir, onSort, selected, onSelect, onToggle, onBreakdown, timeframe,
  selectedIds, onSelectId, onSelectAll, onReclassify, cursorLiveUsage,
}: Props) {
  const { columns: visible } = useSettings()
  const suffix = timeframe ? tfLabel(timeframe) : ''
  const COLUMNS = BASE_COLUMNS
    .filter(col => visible[col.key as ColumnKey])
    .map(col => {
      const isDollar = col.key === 'activeDollars' || col.key === 'loadedDollars' || col.key === 'totalDollars'
      const label = isDollar && suffix ? `${col.labelBase} (${suffix})` : col.labelBase
      return { ...col, label }
    })

  const allChecked = skills.length > 0 && skills.every(s => selectedIds?.has(s.id))
  const someChecked = !allChecked && skills.some(s => selectedIds?.has(s.id))

  return (
    <div className="table-wrap">
      <table className="inventory-table">
        <thead>
          <tr>
            <th className="col-check" onClick={e => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={allChecked}
                ref={el => { if (el) el.indeterminate = someChecked }}
                onChange={e => onSelectAll?.(e.target.checked)}
                title="Select all"
              />
            </th>
            {COLUMNS.map(col => (
              <th
                key={col.key}
                className={[
                  `col-${col.key}`,
                  sortKey === col.key ? 'sorted' : '',
                  col.numeric ? 'col-numeric' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => onSort(col.key)}
                title={col.title ?? col.label}
              >
                <span className="th-label">
                  <span className="th-label-text">{col.label}</span>
                  {sortKey === col.key && (
                    <span className="sort-arrow">
                      {sortDir === 'asc'
                        ? <IconChevronUp size={12} stroke={2} aria-hidden />
                        : <IconChevronDown size={12} stroke={2} aria-hidden />}
                    </span>
                  )}
                </span>
              </th>
            ))}
            {visible.enabled && <th className="col-enabled">Enabled</th>}
          </tr>
        </thead>
        <tbody>
          {skills.map(skill => {
            const isMCP = skill.type === 'mcp'
            const isCursor = skill.account === 'cursor'
            // Codex behaves like Cursor for the cost columns — no per-skill
            // billing data, no activation signal — but has no live-usage
            // repurpose either, so all three dollar cells just show "—".
            const isCodex = skill.account === 'codex'
            // For cursor rows: Active/Loaded columns repurposed as live usage.
            //   Active$  → "Used" cell    (count of activations since polling)
            //   Loaded$  → "Last used"    (relative date of last activation)
            //   Total$   → "—"            (no meaningful per-skill total)
            const cursorLive = isCursor ? cursorLiveUsage?.get(skill.name) : undefined
            const cursorUsedCount = cursorLive?.count ?? 0
            const cursorLastSeen = cursorLive?.lastSeen ?? 0
            const cursorUsedTitle = cursorUsedCount > 0
              ? `${cursorUsedCount} activation${cursorUsedCount === 1 ? '' : 's'} recorded since LSM started polling Cursor's recently-used lists.`
              : 'No activations recorded since polling began. Body/listing token sizes are visible in the detail drawer.'
            const cursorLastSeenTitle = cursorLastSeen
              ? `Last activation: ${new Date(cursorLastSeen).toLocaleString()}`
              : 'No activations recorded yet.'
            return (
              <tr
                key={skill.id}
                className={[
                  selected?.id === skill.id ? 'selected' : '',
                  skill.disabled ? 'row-disabled' : '',
                  selectedIds?.has(skill.id) ? 'row-checked' : '',
                  isMCP && skill.mcpData?.kind === 'session-injected' ? 'row-session-injected' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => onSelect(skill)}
              >
                <td className="col-check" onClick={e => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedIds?.has(skill.id) ?? false}
                    onChange={e => onSelectId?.(skill.id, e.target.checked)}
                  />
                </td>
                {visible.health && (
                  <td className="col-health">
                    <HealthBadge health={skill.health} skill={skill} />
                  </td>
                )}
                {visible.insight && (
                  <td className="col-insight">
                    <InsightBadge
                      insight={skill.insight}
                      dormant={skill.dormant}
                      activeDollars={skill.activeDollars}
                      loadedDollars={skill.loadedDollars}
                      lastInvoked={skill.lastInvoked}
                      bloat={skill.bloat}
                      descLen={skill.descLen}
                      suggestedType={skill.suggestedType}
                      skill={skill}
                      onReclassify={onReclassify}
                    />
                  </td>
                )}
                {visible.name && (
                  <td className="col-name">
                    <span className="skill-name">{skill.name}</span>
                    {skill.description && (
                      <span className="skill-desc">{skill.description}</span>
                    )}
                  </td>
                )}
                {visible.type && (
                  <td className="col-type">
                    <span className={`type-badge type-${skill.type}`}>
                      {TYPE_LABELS[skill.type] ?? skill.type}
                    </span>
                  </td>
                )}
                {visible.scope && (
                  <td className="col-scope">
                    <ContextCell skill={skill} />
                  </td>
                )}
                {visible.lastModified && (
                  <td className="col-lastModified">
                    {isMCP
                      ? (skill.lastInvoked ? formatDate(skill.lastInvoked) : '—')
                      : formatDate(skill.lastModified)}
                  </td>
                )}
                {visible.activeDollars && (
                <td className="col-activeDollars col-numeric">
                  {isCodex ? (
                    <span className="col-mcp-dash" title="Codex doesn't expose a per-skill activation signal.">—</span>
                  ) : isCursor ? (
                    cursorUsedCount > 0 ? (
                      <span className="cursor-live-count" title={cursorUsedTitle}>
                        {cursorUsedCount}
                      </span>
                    ) : (
                      <span className="col-mcp-dash" title={cursorUsedTitle}>0</span>
                    )
                  ) : isMCP ? (
                    skill.activeDollars > 0
                      ? <span className="dollar-link" onClick={e => e.stopPropagation()} title="MCP active cost">{fmtDollars(skill.activeDollars)}</span>
                      : <span className="col-mcp-dash">—</span>
                  ) : (
                    <span
                      className="dollar-link"
                      onClick={e => { e.stopPropagation(); onBreakdown(skill) }}
                      title="Show cost breakdown"
                    >
                      {fmtDollars(skill.activeDollars)}
                    </span>
                  )}
                </td>
                )}
                {visible.loadedDollars && (
                <td className="col-loadedDollars col-numeric">
                  {isCodex ? (
                    <span className="col-mcp-dash" title="Codex doesn't expose activation timestamps.">—</span>
                  ) : isCursor ? (
                    <span className={cursorLastSeen ? '' : 'col-mcp-dash'} title={cursorLastSeenTitle}>
                      {fmtRelative(cursorLastSeen)}
                    </span>
                  ) : isMCP ? <span className="col-mcp-dash">—</span> : (
                    <span
                      className="dollar-link"
                      onClick={e => { e.stopPropagation(); onBreakdown(skill) }}
                      title="Show cost breakdown"
                    >
                      {fmtDollars(skill.loadedDollars)}
                    </span>
                  )}
                </td>
                )}
                {visible.totalDollars && (
                <td className="col-totalDollars col-numeric">
                  {isCodex ? (
                    <span className="col-mcp-dash" title="Codex doesn't expose per-skill billing.">—</span>
                  ) : isCursor ? (
                    <span className="col-mcp-dash" title="Cursor billing isn't accessible — see the detail drawer for body/listing token sizes.">—</span>
                  ) : isMCP ? (
                    skill.totalDollars > 0
                      ? <span className="dollar-link" onClick={e => e.stopPropagation()} title="MCP total cost">{fmtDollars(skill.totalDollars)}</span>
                      : <span className="col-mcp-dash">—</span>
                  ) : (
                    <span
                      className="dollar-link"
                      onClick={e => { e.stopPropagation(); onBreakdown(skill) }}
                      title="Show cost breakdown"
                    >
                      {fmtDollars(skill.totalDollars)}
                    </span>
                  )}
                </td>
                )}
                {visible.enabled && (
                <td className="col-enabled" onClick={e => e.stopPropagation()}>
                  {isCodex ? (
                    <span className="col-mcp-dash" title="Codex has no enable/disable mechanism for AGENTS.md — edit the file directly.">—</span>
                  ) : isCursor ? (
                    <span className="col-mcp-dash" title="Cursor manages skill activation through its own UI">—</span>
                  ) : isMCP ? (
                    <span className="col-mcp-dash" title="Configure in ~/.claude.json">—</span>
                  ) : (
                    <ToggleSwitch
                      checked={!skill.disabled}
                      onChange={enabled => onToggle(skill, enabled)}
                      title={skill.disabled ? 'Enable skill' : 'Disable skill'}
                    />
                  )}
                </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

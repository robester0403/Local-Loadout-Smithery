// Small presentational subcomponents extracted from the RelationshipMap.
// Kept as named exports in one file to avoid file-explosion for trivial UI.

import { Fragment, type ReactNode } from 'react'
import type { Skill } from '../../types'
import {
  type Direction,
  DEPTH_OPTIONS,
  DIRECTION_OPTIONS,
  ZOOM_MAX,
  ZOOM_MIN,
} from './graph'

// ─── Type legend (skill / command / subagent / selected) ─────────────────────
export function RelmapTypeLegend() {
  return (
    <div className="relmap-type-legend">
      <span className="relmap-type-item"><span className="relmap-shape-rect" /> skill</span>
      <span className="relmap-type-item"><span className="relmap-shape-round" /> command</span>
      <span className="relmap-type-item"><span className="relmap-shape-sub" /> subagent</span>
      <span className="relmap-type-item relmap-type-root"><span className="relmap-shape-root" /> selected</span>
    </div>
  )
}

// ─── Direction + depth controls ──────────────────────────────────────────────
interface ControlsProps {
  direction: Direction
  onDirectionChange: (d: Direction) => void
  maxDepth: number
  onDepthChange: (d: number) => void
}

export function RelmapControls({ direction, onDirectionChange, maxDepth, onDepthChange }: ControlsProps) {
  return (
    <div className="relmap-controls">
      <div className="relmap-control-group" role="radiogroup" aria-label="Direction">
        <span className="relmap-control-label">Direction</span>
        {DIRECTION_OPTIONS.map(opt => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={direction === opt.value}
            title={opt.title}
            className={`relmap-control-btn ${direction === opt.value ? 'is-active' : ''}`}
            onClick={() => onDirectionChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <div className="relmap-control-group" role="radiogroup" aria-label="Depth">
        <span className="relmap-control-label">Depth</span>
        {DEPTH_OPTIONS.map(opt => (
          <button
            key={opt.label}
            type="button"
            role="radio"
            aria-checked={maxDepth === opt.value}
            title={
              opt.value === Number.POSITIVE_INFINITY
                ? 'Show the entire connected component (may be large)'
                : `Show up to ${opt.label} hop${opt.value === 1 ? '' : 's'} in each direction`
            }
            className={`relmap-control-btn ${maxDepth === opt.value ? 'is-active' : ''}`}
            onClick={() => onDepthChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Zoom toolbar (bottom-right of the graph pane) ───────────────────────────
interface ZoomToolbarProps {
  zoom: number
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
}

export function RelmapZoomToolbar({ zoom, onZoomIn, onZoomOut, onFit }: ZoomToolbarProps) {
  return (
    <div className="relmap-zoom" role="toolbar" aria-label="Zoom">
      <button
        type="button"
        className="relmap-zoom-btn"
        onClick={onZoomOut}
        disabled={zoom <= ZOOM_MIN}
        title="Zoom out"
        aria-label="Zoom out"
      >−</button>
      <button
        type="button"
        className="relmap-zoom-btn relmap-zoom-fit"
        onClick={onFit}
        title="Fit to screen"
      >Fit</button>
      <span className="relmap-zoom-level" aria-live="polite">{Math.round(zoom * 100)}%</span>
      <button
        type="button"
        className="relmap-zoom-btn"
        onClick={onZoomIn}
        disabled={zoom >= ZOOM_MAX}
        title="Zoom in"
        aria-label="Zoom in"
      >+</button>
    </div>
  )
}

// ─── Fullscreen toggle button (top-right of the graph pane) ──────────────────
interface FullscreenButtonProps {
  fullscreen: boolean
  onToggle: () => void
}

export function RelmapFullscreenButton({ fullscreen, onToggle }: FullscreenButtonProps) {
  return (
    <button
      type="button"
      className="relmap-fullscreen-btn"
      onClick={onToggle}
      title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
    >
      {fullscreen ? '⊟' : '⛶'}
    </button>
  )
}

// ─── Info rail (right side of the modal body) ────────────────────────────────
interface InfoRailProps {
  skill: Skill
  isHovering: boolean
  isRoot: boolean
  /** Every artifact name in the loadout, used to highlight mentions in the
   *  description. Self-references are skipped. */
  knownNames: ReadonlySet<string>
}

export function RelmapInfoRail({ skill, isHovering, isRoot, knownNames }: InfoRailProps) {
  const refCount = (skill.references ?? []).length
  return (
    <aside className="relmap-rail">
      <div className="relmap-rail-header">
        <span className={`type-badge type-${skill.type}`}>{skill.type}</span>
        {isRoot && !isHovering && <span className="relmap-rail-tag">selected</span>}
        {isHovering && <span className="relmap-rail-tag relmap-rail-tag-hover">hovering</span>}
      </div>
      <h3 className="relmap-rail-title">{skill.name}</h3>
      {skill.description ? (
        <p className="relmap-rail-desc">
          {highlightMentions(skill.description, knownNames, skill.name)}
        </p>
      ) : (
        <p className="relmap-rail-desc relmap-rail-desc-empty">No description.</p>
      )}

      <dl className="relmap-rail-stats">
        <Stat label="Active $" value={fmtDollars(skill.activeDollars ?? 0)} />
        <Stat label="Loaded $" value={fmtDollars(skill.loadedDollars ?? 0)} />
        <Stat label="Last invoked" value={fmtDate(skill.lastInvoked)} />
        <Stat label="References" value={`${refCount} out`} />
        <Stat
          label="Scope"
          value={`${skill.scope}${skill.account && skill.account !== 'default' ? ` · ${skill.account}` : ''}`}
        />
      </dl>

      <p className="relmap-rail-hint">
        Hover to preview · click to switch detail view · drag to pan
      </p>
    </aside>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

// Bold every occurrence in `text` of any name in `names`, except `selfName`.
// Longest-first matching prevents partial hits (e.g. "gh" matching inside
// "gh-cli"). Boundaries use [\w:-] so hyphens and colons inside a name don't
// fragment matches, but adjacent letters/dashes still keep us from matching
// substrings.
function highlightMentions(
  text: string,
  names: ReadonlySet<string>,
  selfName: string,
): ReactNode {
  if (!text || names.size === 0) return text
  const candidates = Array.from(names)
    .filter(n => n.length > 1 && n !== selfName)
    .sort((a, b) => b.length - a.length)
  if (candidates.length === 0) return text

  const pattern = candidates.map(escapeRegex).join('|')
  const re = new RegExp(`(?<![\\w:-])(?:${pattern})(?![\\w:-])`, 'g')

  const out: ReactNode[] = []
  let lastIdx = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIdx) out.push(text.slice(lastIdx, match.index))
    out.push(<strong key={`m${match.index}`} className="relmap-rail-mention">{match[0]}</strong>)
    lastIdx = re.lastIndex
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx))
  // Wrap in a Fragment so callers can render directly.
  return <Fragment>{out}</Fragment>
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fmtDollars(n: number): string {
  if (n === 0) return '$0'
  if (n >= 0.0001) return '$' + n.toFixed(4)
  return '$' + n.toFixed(6)
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

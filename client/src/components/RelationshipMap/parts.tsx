// Small presentational subcomponents extracted from the RelationshipMap.
// Kept as named exports in one file to avoid file-explosion for trivial UI.
//
// Pure body/description text helpers (findBodyMentions, highlightMentions)
// live in `mentions.tsx`. This file should stay focused on JSX components.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Skill } from '../../types'
import EditableText from '../EditableText'
import {
  type Direction,
  DEPTH_OPTIONS,
  DIRECTION_OPTIONS,
  ZOOM_MAX,
  ZOOM_MIN,
} from './graph'
import {
  type BodyJump,
  type BodySnippet,
  MAX_BODY_MENTIONS,
  findBodyMentions,
  highlightMentions,
} from './mentions'

// Re-export so callers (index.tsx) can import RelmapInfoRail + BodyJump from
// one place. Keeps the module surface flat without churning imports.
export type { BodyJump } from './mentions'

// ─── Type legend (skill / command / subagent / selected) ─────────────────────
export function RelmapTypeLegend() {
  return (
    <section className="relmap-toprow-section relmap-type-legend-wrap">
      <span className="relmap-toprow-label">Legend</span>
      <div className="relmap-type-legend">
        <span className="relmap-type-item relmap-type-skill">
          <span className="relmap-shape-rect" /> skill
        </span>
        <span className="relmap-type-item relmap-type-command">
          <span className="relmap-shape-round" /> command
        </span>
        <span className="relmap-type-item relmap-type-subagent">
          <span className="relmap-shape-sub" /> subagent
        </span>
        <span className="relmap-type-item relmap-type-mcp">
          <span className="relmap-shape-mcp" /> mcp
        </span>
        <span className="relmap-type-item relmap-type-root">
          <span className="relmap-shape-root" /> selected
        </span>
        <span className="relmap-legend-divider" />
        <span className="relmap-legend-item">── direct</span>
        <span className="relmap-legend-item">·· body mention</span>
      </div>
    </section>
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
    <section className="relmap-toprow-section">
      <span className="relmap-toprow-label">Controls</span>
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
    </section>
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

// ─── Rail sub-section ────────────────────────────────────────────────────────
// Light wrapper around <details> for the four near-identical collapsible
// blocks inside the info rail. Controlled and uncontrolled forms both work:
// pass `open`/`onOpenChange` for controlled state, or omit them + pass
// `defaultOpen` for the native default.
interface RailSectionProps {
  label: ReactNode
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
  children: ReactNode
}

function RailSection({
  label,
  defaultOpen,
  open,
  onOpenChange,
  className,
  children,
}: RailSectionProps) {
  const controlled = open !== undefined
  return (
    <details
      className={`relmap-rail-section${className ? ` ${className}` : ''}`}
      {...(controlled ? { open } : { open: defaultOpen })}
      onToggle={e => onOpenChange?.((e.target as HTMLDetailsElement).open)}
    >
      <summary className="relmap-rail-section-summary">{label}</summary>
      {children}
    </details>
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
  /** Latest body-mention jump request. When set, the Body section auto-opens
   *  and scrolls to the matching mention; the graph is scrolled by the
   *  parent. Comparing `nonce` lets repeated clicks re-fire. */
  bodyJump?: BodyJump | null
  /** Called when a snippet is clicked. Parent uses this to navigate the
   *  graph and dispatch the body-scroll via `bodyJump`. */
  onJumpToMention?: (name: string, offset: number) => void
  /** Persist a description / body edit. When provided, the rail renders
   *  inline edit affordances on those two sections. */
  onSaveDescription?: (next: string) => Promise<void>
  onSaveBody?: (next: string) => Promise<void>
  /** Fired when the rail enters / leaves an edit. The parent uses this to
   *  freeze the rail on the current skill so hover-driven previews don't
   *  swap the rail out from under an in-flight edit. */
  onEditingChange?: (editing: boolean) => void
}

export function RelmapInfoRail({
  skill,
  isHovering,
  isRoot,
  knownNames,
  bodyJump,
  onJumpToMention,
  onSaveDescription,
  onSaveBody,
  onEditingChange,
}: InfoRailProps) {
  // Edits only fire on the currently-focused root: when the rail is showing
  // a hover preview, a pencil click on it would still operate on the actual
  // skill behind the preview, which is confusing. Skip MCPs entirely — they
  // aren't file-backed.
  const canEdit = isRoot && skill.type !== 'mcp'
  const refCount = (skill.references ?? []).length
  const hasBody = !!(skill.body && skill.body.trim().length > 0)

  const bodyRef = useRef<HTMLPreElement>(null)
  const [bodyOpen, setBodyOpen] = useBodyMentionJump(skill.name, bodyJump, bodyRef)

  return (
    <aside className="relmap-rail">
      <div className="relmap-rail-header">
        <span className={`type-badge type-${skill.type}`}>{skill.type}</span>
        {isRoot && !isHovering && <span className="relmap-rail-tag">selected</span>}
        {isHovering && <span className="relmap-rail-tag relmap-rail-tag-hover">hovering</span>}
      </div>
      <h3 className="relmap-rail-title">{skill.name}</h3>

      <RailSection label="Description" defaultOpen>
        {canEdit && onSaveDescription ? (
          <EditableText
            className="relmap-rail-desc"
            variant="line"
            value={skill.description ?? ''}
            emptyText="No description."
            label="Edit description"
            onSave={onSaveDescription}
            onEditStart={() => onEditingChange?.(true)}
            onEditEnd={() => onEditingChange?.(false)}
            renderValue={v => highlightMentions(v, knownNames, skill.name)}
          />
        ) : skill.description ? (
          <p className="relmap-rail-desc">
            {highlightMentions(skill.description, knownNames, skill.name)}
          </p>
        ) : (
          <p className="relmap-rail-desc relmap-rail-desc-empty">No description.</p>
        )}
      </RailSection>

      <RailSection
        label={`Body${hasBody ? '' : ' (empty)'}`}
        open={bodyOpen}
        onOpenChange={setBodyOpen}
      >
        {canEdit && onSaveBody ? (
          <EditableText
            className="relmap-rail-body-edit"
            variant="block"
            value={skill.body ?? ''}
            emptyText="No body."
            label="Edit body"
            onSave={onSaveBody}
            onEditStart={() => onEditingChange?.(true)}
            onEditEnd={() => onEditingChange?.(false)}
            renderValue={v => (
              <pre className="relmap-rail-body" ref={bodyRef}>
                {highlightMentions(v, knownNames, skill.name)}
              </pre>
            )}
          />
        ) : hasBody ? (
          <pre className="relmap-rail-body" ref={bodyRef}>
            {highlightMentions(skill.body, knownNames, skill.name)}
          </pre>
        ) : (
          <p className="relmap-rail-desc relmap-rail-desc-empty">No body.</p>
        )}
      </RailSection>

      <BodyMentions skill={skill} knownNames={knownNames} onJumpToMention={onJumpToMention} />

      <DiagnosticMentions skill={skill} onJumpToOffset={onJumpToMention} />

      <RailSection label="Stats" className="relmap-rail-stats-section">
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
      </RailSection>

      <p className="relmap-rail-hint">
        Hover to preview · click to switch detail view · drag to pan
      </p>
    </aside>
  )
}

// Controls the Body section's open state in response to body-mention jumps.
// Two-pass: when a jump arrives we first force open (if collapsed), then —
// once the open state has committed and the children have layout — scroll
// to the matching mention. Doing both in one effect fails when the section
// starts collapsed because a sync DOM read can race React's commit, finding
// the element with no box (scrollIntoView is then a no-op).
//
// Nonce tracking via refs ensures each click acts exactly once: without it
// the open-effect would re-fire on every `bodyOpen` change, immediately
// re-opening the section after the user manually collapses it.
function useBodyMentionJump(
  skillName: string,
  bodyJump: BodyJump | null | undefined,
  bodyRef: React.RefObject<HTMLPreElement | null>,
): [boolean, (open: boolean) => void] {
  const [bodyOpen, setBodyOpen] = useState<boolean>(false)
  const handledNonceRef = useRef<number | null>(null)
  const scrolledNonceRef = useRef<number | null>(null)

  // Reset everything whenever the focused skill changes so jumps from one
  // artifact don't leak into the next.
  useEffect(() => {
    setBodyOpen(false)
    handledNonceRef.current = null
    scrolledNonceRef.current = null
  }, [skillName])

  useEffect(() => {
    if (!bodyJump) return
    if (handledNonceRef.current === bodyJump.nonce) return
    handledNonceRef.current = bodyJump.nonce
    if (!bodyOpen) setBodyOpen(true)
  }, [bodyJump, bodyOpen])

  useLayoutEffect(() => {
    if (!bodyJump || !bodyOpen) return
    if (scrolledNonceRef.current === bodyJump.nonce) return
    scrolledNonceRef.current = bodyJump.nonce
    const el = bodyRef.current?.querySelector<HTMLElement>(
      `[data-mention-offset="${bodyJump.offset}"]`,
    )
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('relmap-rail-mention-flash')
    const t = window.setTimeout(() => el.classList.remove('relmap-rail-mention-flash'), 1400)
    return () => window.clearTimeout(t)
  }, [bodyJump, bodyOpen, bodyRef])

  return [bodyOpen, setBodyOpen]
}

interface BodyMentionsProps {
  skill: Skill
  knownNames: ReadonlySet<string>
  onJumpToMention?: (name: string, offset: number) => void
}

function BodyMentions({ skill, knownNames, onJumpToMention }: BodyMentionsProps) {
  const snippets = findBodyMentions(skill.body ?? '', knownNames, skill.name)
  if (snippets.length === 0) return null

  const countLabel = `${snippets.length}${snippets.length === MAX_BODY_MENTIONS ? '+' : ''}`
  return (
    <RailSection
      defaultOpen
      className="relmap-rail-snippets"
      label={
        <>
          Body mentions <span className="relmap-rail-snippets-count">· {countLabel}</span>
        </>
      }
    >
      <ul className="relmap-rail-snippets-list">
        {snippets.map((s, i) => (
          <SnippetItem key={i} snippet={s} onJump={onJumpToMention} />
        ))}
      </ul>
    </RailSection>
  )
}

function SnippetItem({
  snippet: s,
  onJump,
}: {
  snippet: BodySnippet
  onJump?: (name: string, offset: number) => void
}) {
  return (
    <li>
      <button
        type="button"
        className="relmap-rail-snippet"
        onClick={() => onJump?.(s.match, s.offset)}
        title={`Jump to ${s.match}`}
      >
        {s.hasMore && '…'}
        {/* Collapse internal whitespace so multi-line markdown doesn't blow up vertically. */}
        {s.before.replace(/\s+/g, ' ')}
        <strong className="relmap-rail-mention">{s.match}</strong>
        {s.after.replace(/\s+/g, ' ')}
        {s.hasMoreAfter && '…'}
      </button>
    </li>
  )
}

// LOC-95: rail section for slash-in-path and other ambiguous-mention
// diagnostics. Distinct from BodyMentions (confirmed) — these are
// "you might have meant to reference X" hints. Hidden when empty.
function DiagnosticMentions({
  skill,
  onJumpToOffset,
}: {
  skill: Skill
  onJumpToOffset?: (name: string, offset: number) => void
}) {
  const diagnostics = skill.diagnostics ?? []
  if (diagnostics.length === 0) return null
  return (
    <RailSection
      defaultOpen
      className="relmap-rail-snippets"
      label={
        <>
          Possibly missed mentions <span className="relmap-rail-snippets-count">· {diagnostics.length}</span>
        </>
      }
    >
      <ul className="relmap-rail-snippets-list">
        {diagnostics.map((d, i) => (
          <li key={i}>
            <button
              type="button"
              className="relmap-rail-snippet"
              onClick={() => onJumpToOffset?.(d.artifactName, d.offset)}
              title={`Jump to ${d.matched}`}
              style={{ fontStyle: 'italic', opacity: 0.85 }}
            >
              <span style={{ fontFamily: 'monospace', fontSize: 11 }}>…{d.matched}…</span>
              <br />
              <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{d.suggestion}</span>
            </button>
          </li>
        ))}
      </ul>
    </RailSection>
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

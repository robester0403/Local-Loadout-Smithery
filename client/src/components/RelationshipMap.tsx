import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Skill } from '../types'
import mermaid from 'mermaid'

interface Props {
  skill: Skill
  allSkills: Skill[]
  onClose: () => void
  // Called when the user clicks a node in the rendered graph. Passing this
  // makes the map navigable — clicking switches the detail view to the chosen
  // artifact. Broken-ref placeholder nodes (skills that don't exist in
  // allSkills) are silently ignored.
  onSelect?: (skill: Skill) => void
}

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  themeVariables: {
    darkMode: true,
    background: '#0f0f13',
    mainBkg: '#17171f',
    nodeBorder: '#2a2a38',
    clusterBkg: '#1e1e28',
    titleColor: '#e4e0f4',
    edgeLabelBackground: '#17171f',
    lineColor: '#6a6680',
  },
  flowchart: { curve: 'basis', htmlLabels: true },
  securityLevel: 'loose',
})

type Direction = 'in' | 'out' | 'both'

// ─── Build the ancestor + descendant chain bounded by depth + direction ──────
function buildChain(
  root: Skill,
  allSkills: Skill[],
  maxDepth: number,
  direction: Direction,
): {
  nodes: Map<string, Skill>
  edges: Array<{ from: string; to: string; source: string }>
} {
  const byName = new Map(allSkills.map(s => [s.name, s]))
  const nodes = new Map<string, Skill>()
  const edges: Array<{ from: string; to: string; source: string }> = []
  const edgeSet = new Set<string>()

  function addEdge(from: string, to: string, source: string) {
    const key = `${from}→${to}`
    if (edgeSet.has(key)) return
    edgeSet.add(key)
    edges.push({ from, to, source })
  }

  // Always include the root.
  nodes.set(root.name, root)

  // BFS forward (descendants): only when direction permits.
  if (direction === 'out' || direction === 'both') {
    const visited = new Set<string>()
    const queue: Array<{ skill: Skill; depth: number }> = [{ skill: root, depth: 0 }]
    while (queue.length > 0) {
      const { skill: s, depth } = queue.shift()!
      if (visited.has(s.name)) continue
      visited.add(s.name)
      if (depth >= maxDepth) continue
      for (const ref of s.references ?? []) {
        const target = byName.get(ref.name)
        if (target) {
          if (!nodes.has(target.name)) nodes.set(target.name, target)
          addEdge(s.name, ref.name, ref.source)
          if (!visited.has(ref.name)) queue.push({ skill: target, depth: depth + 1 })
        } else {
          // broken ref — add placeholder so the user can see the dangling pointer
          if (!nodes.has(ref.name)) {
            nodes.set(ref.name, {
              ...s, name: ref.name, type: 'skill', id: ref.name,
              description: '', health: { status: 'warn', issues: [] }, references: [],
            } as unknown as Skill)
          }
          addEdge(s.name, ref.name, ref.source)
        }
      }
    }
  }

  // BFS backward (ancestors): only when direction permits.
  if (direction === 'in' || direction === 'both') {
    const visited = new Set<string>([root.name])
    type BwdEntry = { name: string; depth: number }
    // seed: anything that references the root
    const queue: BwdEntry[] = allSkills
      .filter(s => s.references?.some(r => r.name === root.name))
      .map(s => ({ name: s.name, depth: 1 }))

    while (queue.length > 0) {
      const { name, depth } = queue.shift()!
      if (visited.has(name)) continue
      visited.add(name)
      const s = byName.get(name)
      if (!s) continue
      if (!nodes.has(s.name)) nodes.set(s.name, s)
      // Add edges from this ancestor to anything it references that's already
      // in the node set — this includes the root and other in-graph nodes.
      for (const ref of s.references ?? []) {
        if (nodes.has(ref.name)) addEdge(s.name, ref.name, ref.source)
      }
      if (depth >= maxDepth) continue
      // Find ancestors of this ancestor and queue them.
      for (const a of allSkills) {
        if (visited.has(a.name)) continue
        if (a.references?.some(r => r.name === s.name)) {
          queue.push({ name: a.name, depth: depth + 1 })
        }
      }
    }
  }

  return { nodes, edges }
}

// ─── Mermaid syntax generator ─────────────────────────────────────────────────
function sanitizeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_')
}

function escapeMermaidLabel(name: string): string {
  return name.replace(/"/g, "'")
}

function typeShape(type: string): [string, string] {
  switch (type) {
    case 'command':  return ['(', ')']   // rounded
    case 'subagent': return ['[[', ']]'] // subroutine
    default:         return ['[', ']']   // rectangle
  }
}

function buildMermaid(
  root: Skill,
  nodes: Map<string, Skill>,
  edges: Array<{ from: string; to: string; source: string }>,
): string {
  const lines: string[] = ['flowchart LR']

  for (const [name, skill] of nodes) {
    const id = sanitizeId(name)
    const label = escapeMermaidLabel(name)
    const [open, close] = typeShape(skill.type)
    lines.push(`  ${id}${open}"${label}"${close}`)
  }

  for (const edge of edges) {
    const from = sanitizeId(edge.from)
    const to = sanitizeId(edge.to)
    const arrow = edge.source === 'command' ? '-->' : '-.->'
    lines.push(`  ${from} ${arrow} ${to}`)
  }

  const rootId = sanitizeId(root.name)
  lines.push(`  style ${rootId} fill:#4a2d80,stroke:#9d6cf5,color:#e4e0f4,stroke-width:2px`)

  return lines.join('\n')
}

// ─── Component ────────────────────────────────────────────────────────────────
const DEPTH_OPTIONS: Array<{ label: string; value: number }> = [
  { label: '1', value: 1 },
  { label: '2', value: 2 },
  { label: '3', value: 3 },
  { label: 'All', value: Number.POSITIVE_INFINITY },
]

const DIRECTION_OPTIONS: Array<{ label: string; value: Direction; title: string }> = [
  { label: '← In',   value: 'in',   title: 'Show only artifacts that reference this one' },
  { label: '↔ Both', value: 'both', title: 'Show both incoming and outgoing references' },
  { label: '→ Out',  value: 'out',  title: 'Show only artifacts this one references' },
]

export default function RelationshipMap({ skill, allSkills, onClose, onSelect }: Props) {
  // Always-mounted outer container we attach the click delegation handler to.
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [svgHtml, setSvgHtml] = useState<string | null>(null)

  // Controls.
  const [maxDepth, setMaxDepth] = useState<number>(2)
  const [direction, setDirection] = useState<Direction>('both')

  // Name of the node currently under the cursor. Falls back to the root
  // artifact when nothing is hovered, so the info rail always shows something.
  const [hoveredName, setHoveredName] = useState<string | null>(null)

  // Toggle for the modal taking the full viewport. Useful when the graph is
  // large or you want the rail's description text to be readable without
  // squishing the SVG.
  const [fullscreen, setFullscreen] = useState<boolean>(false)

  // Zoom level for the rendered SVG (1 = natural size). The actual sizing is
  // applied declaratively via the wrapper div's inline width/height — the
  // inner svg fills the wrapper via CSS — so unrelated re-renders (e.g. hover
  // state changes) can't perturb the rendered scale.
  const [zoom, setZoom] = useState<number>(1)

  const { nodes, edges } = useMemo(
    () => buildChain(skill, allSkills, maxDepth, direction),
    [skill, allSkills, maxDepth, direction],
  )
  const mermaidSrc = useMemo(
    () => buildMermaid(skill, nodes, edges),
    [skill, nodes, edges],
  )

  // Lookup data for the click handler. Refs so the handler can read current
  // values at click time without re-attaching when the graph changes.
  const skillsByNameRef = useRef<Map<string, Skill>>(new Map())
  skillsByNameRef.current = useMemo(
    () => new Map(allSkills.map(s => [s.name, s])),
    [allSkills],
  )

  useEffect(() => {
    let cancelled = false
    async function render() {
      try {
        const id = `mermaid-${Date.now()}`
        const { svg } = await mermaid.render(id, mermaidSrc)
        if (cancelled) return
        setSvgHtml(svg)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    }
    render()
    return () => { cancelled = true }
  }, [mermaidSrc])

  // Natural dimensions parsed from the rendered SVG's viewBox. Done from the
  // svgHtml string directly so it's available in the same render that mounts
  // the wrapper — no async DOM-querying required.
  const naturalDim = useMemo(() => {
    if (!svgHtml) return null
    const m = svgHtml.match(/viewBox\s*=\s*["']([^"']+)["']/)
    if (!m) return null
    const parts = m[1].split(/\s+/).map(Number)
    if (parts.length === 4 && parts.every(n => Number.isFinite(n))) {
      return { w: parts[2], h: parts[3] }
    }
    return null
  }, [svgHtml])

  // Tracks the last svgHtml we auto-fit so we don't fight the user's zoom on
  // unrelated re-renders.
  const lastFitSvgRef = useRef<string | null>(null)

  // On every new svgHtml, compute fit-to-screen and apply. useLayoutEffect so
  // the zoom state lands before the browser paints, avoiding a flash of the
  // graph at the previous (unrelated) zoom.
  useLayoutEffect(() => {
    if (!svgHtml || !naturalDim || !graphRef.current) return
    if (lastFitSvgRef.current === svgHtml) return
    lastFitSvgRef.current = svgHtml
    const { width, height } = graphRef.current.getBoundingClientRect()
    const availW = Math.max(40, width - 24)   // 12px padding each side
    const availH = Math.max(40, height - 24)
    const fit = Math.min(availW / naturalDim.w, availH / naturalDim.h)
    setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, +fit.toFixed(2))))
  }, [svgHtml, naturalDim])

  const ZOOM_MIN = 0.2
  const ZOOM_MAX = 4
  const ZOOM_STEP = 0.2

  const zoomIn = () => setZoom(z => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)))
  const zoomOut = () => setZoom(z => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)))
  const fitToScreen = () => {
    const graphEl = graphRef.current
    if (!naturalDim || !graphEl) return
    const { width, height } = graphEl.getBoundingClientRect()
    // Account for padding on .relmap-graph (12px each side from CSS).
    const availW = Math.max(40, width - 24)
    const availH = Math.max(40, height - 24)
    const fit = Math.min(availW / naturalDim.w, availH / naturalDim.h)
    setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, +fit.toFixed(2))))
  }

  // DOM event delegation on the outer (always-mounted) container. Click
  // dispatches navigation; mouseover/mouseleave drives the info rail. Handlers
  // attach once for the modal's lifetime so graph re-renders, depth/direction
  // changes, and orphan-state transitions are all transparent — no rebinding.
  useEffect(() => {
    const root = containerRef.current
    if (!root) return

    function nameFromNode(node: Element): string | null {
      const labelEl = node.querySelector('.nodeLabel, foreignObject, .label, text')
      const label = (labelEl?.textContent ?? node.textContent ?? '').trim()
      if (!label) return null
      if (skillsByNameRef.current.has(label)) return label
      for (const name of skillsByNameRef.current.keys()) {
        if (escapeMermaidLabel(name) === label) return name
      }
      return null
    }

    const onClick = (e: MouseEvent) => {
      if (!onSelect) return
      const target = e.target as Element | null
      const node = target?.closest('.node')
      if (!node) return
      const name = nameFromNode(node)
      if (!name) return
      const s = skillsByNameRef.current.get(name)
      if (s) onSelect(s)
    }

    const onMouseOver = (e: MouseEvent) => {
      const target = e.target as Element | null
      const node = target?.closest('.node')
      if (!node) return
      const name = nameFromNode(node)
      setHoveredName(name)  // null is fine — rail falls back to root
    }

    const onMouseLeave = () => setHoveredName(null)

    root.addEventListener('click', onClick)
    root.addEventListener('mouseover', onMouseOver)
    root.addEventListener('mouseleave', onMouseLeave)
    return () => {
      root.removeEventListener('click', onClick)
      root.removeEventListener('mouseover', onMouseOver)
      root.removeEventListener('mouseleave', onMouseLeave)
    }
  }, [onSelect])

  // Whatever the rail should show right now: hovered node, or the root when
  // nothing is being hovered.
  const railSkill: Skill =
    (hoveredName && skillsByNameRef.current.get(hoveredName)) || skill

  const isOrphan = nodes.size === 1 && edges.length === 0

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`modal relmap-modal ${fullscreen ? 'relmap-modal-fullscreen' : ''}`}>
        <div className="modal-header">
          <div>
            <div className="modal-title">{skill.name} — relationship map</div>
            <div className="modal-subtitle">
              {nodes.size} {nodes.size === 1 ? 'artifact' : 'artifacts'} · {edges.length} edge{edges.length !== 1 ? 's' : ''} ·{' '}
              <span className="relmap-legend">
                <span className="relmap-legend-item">── direct &nbsp;</span>
                <span className="relmap-legend-item">·· body mention</span>
              </span>
            </div>
          </div>
          <div className="relmap-modal-buttons">
            <button
              type="button"
              className="btn btn-sm modal-close"
              onClick={() => setFullscreen(f => !f)}
              title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {fullscreen ? '⊟' : '⛶'}
            </button>
            <button className="btn btn-sm modal-close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

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
                onClick={() => setDirection(opt.value)}
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
                title={opt.value === Number.POSITIVE_INFINITY
                  ? 'Show the entire connected component (may be large)'
                  : `Show up to ${opt.label} hop${opt.value === 1 ? '' : 's'} in each direction`}
                className={`relmap-control-btn ${maxDepth === opt.value ? 'is-active' : ''}`}
                onClick={() => setMaxDepth(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="relmap-type-legend">
          <span className="relmap-type-item"><span className="relmap-shape-rect" /> skill</span>
          <span className="relmap-type-item"><span className="relmap-shape-round" /> command</span>
          <span className="relmap-type-item"><span className="relmap-shape-sub" /> subagent</span>
          <span className="relmap-type-item relmap-type-root"><span className="relmap-shape-root" /> selected</span>
        </div>

        <div className="relmap-body" ref={containerRef}>
          <div className="relmap-graph-wrap">
            <div className="relmap-graph" ref={graphRef}>
              {isOrphan ? (
                <div className="relmap-orphan">
                  <div className="relmap-orphan-icon">◉</div>
                  <div>No relationships visible at the current depth and direction.</div>
                  <div className="relmap-orphan-sub">Try increasing depth, switching direction, or this artifact is genuinely an island.</div>
                </div>
              ) : error ? (
                <div className="sr-form-error">{error}</div>
              ) : svgHtml ? (
                <div
                  className="relmap-svg"
                  style={naturalDim ? { width: naturalDim.w * zoom, height: naturalDim.h * zoom } : undefined}
                  dangerouslySetInnerHTML={{ __html: svgHtml }}
                />
              ) : (
                <div className="empty-state" style={{ minHeight: 120 }}>
                  <div className="spinner" />
                </div>
              )}
            </div>

            {!isOrphan && !error && svgHtml && (
              <div className="relmap-zoom" role="toolbar" aria-label="Zoom">
                <button
                  type="button"
                  className="relmap-zoom-btn"
                  onClick={zoomOut}
                  disabled={zoom <= ZOOM_MIN}
                  title="Zoom out"
                  aria-label="Zoom out"
                >−</button>
                <button
                  type="button"
                  className="relmap-zoom-btn relmap-zoom-fit"
                  onClick={fitToScreen}
                  title="Fit to screen"
                >Fit</button>
                <span className="relmap-zoom-level" aria-live="polite">{Math.round(zoom * 100)}%</span>
                <button
                  type="button"
                  className="relmap-zoom-btn"
                  onClick={zoomIn}
                  disabled={zoom >= ZOOM_MAX}
                  title="Zoom in"
                  aria-label="Zoom in"
                >+</button>
              </div>
            )}
          </div>

          <RelmapInfoRail skill={railSkill} isHovering={hoveredName != null} isRoot={railSkill.name === skill.name} />
        </div>
      </div>
    </div>
  )
}

// ─── Info rail ────────────────────────────────────────────────────────────────
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

function RelmapInfoRail({ skill, isHovering, isRoot }: { skill: Skill; isHovering: boolean; isRoot: boolean }) {
  const refCount = (skill.references ?? []).length
  return (
    <aside className="relmap-rail">
      <div className="relmap-rail-header">
        <span className={`type-badge type-${skill.type}`}>{skill.type}</span>
        {isRoot && !isHovering && (
          <span className="relmap-rail-tag">selected</span>
        )}
        {isHovering && (
          <span className="relmap-rail-tag relmap-rail-tag-hover">hovering</span>
        )}
      </div>
      <h3 className="relmap-rail-title">{skill.name}</h3>
      {skill.description ? (
        <p className="relmap-rail-desc">{skill.description}</p>
      ) : (
        <p className="relmap-rail-desc relmap-rail-desc-empty">No description.</p>
      )}

      <dl className="relmap-rail-stats">
        <div>
          <dt>Active $</dt>
          <dd>{fmtDollars(skill.activeDollars ?? 0)}</dd>
        </div>
        <div>
          <dt>Loaded $</dt>
          <dd>{fmtDollars(skill.loadedDollars ?? 0)}</dd>
        </div>
        <div>
          <dt>Last invoked</dt>
          <dd>{fmtDate(skill.lastInvoked)}</dd>
        </div>
        <div>
          <dt>References</dt>
          <dd>{refCount}{refCount === 1 ? ' out' : ' out'}</dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>{skill.scope}{skill.account && skill.account !== 'default' ? ` · ${skill.account}` : ''}</dd>
        </div>
      </dl>

      <p className="relmap-rail-hint">
        Hover any node to preview · click to switch detail view
      </p>
    </aside>
  )
}

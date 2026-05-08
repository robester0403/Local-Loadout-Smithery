import { useEffect, useMemo, useRef, useState } from 'react'
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
  const [error, setError] = useState<string | null>(null)
  const [svgHtml, setSvgHtml] = useState<string | null>(null)

  // Controls.
  const [maxDepth, setMaxDepth] = useState<number>(2)
  const [direction, setDirection] = useState<Direction>('both')

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

  // Click handling via DOM event delegation on the outer (always-mounted)
  // container. Previous approaches relied on Mermaid's `click` directive plus
  // bindFunctions(host) — they failed intermittently because the SVG host div
  // unmounts/remounts when toggling between graph and orphan states, and
  // useEffect[svgHtml] doesn't re-fire if svgHtml is unchanged across the
  // remount. With delegation on the outer container, the handler is attached
  // once for the life of the modal and reads the artifact name from each
  // clicked node's visible text — no rebinding, no stale-id parsing.
  useEffect(() => {
    if (!onSelect) return
    const root = containerRef.current
    if (!root) return

    const handler = (e: MouseEvent) => {
      const target = e.target as Element | null
      const node = target?.closest('.node') as SVGElement | null
      if (!node) return

      // Mermaid renders the label as either an HTML span (htmlLabels: true) or
      // a plain <text>. textContent on the node group catches both.
      const labelEl = node.querySelector('.nodeLabel, foreignObject, .label, text')
      const label = (labelEl?.textContent ?? node.textContent ?? '').trim()
      if (!label) return

      // Direct match by name. Most artifacts have no quotes so this hits.
      const direct = skillsByNameRef.current.get(label)
      if (direct) {
        onSelect(direct)
        return
      }
      // Fallback: names with `"` got escaped to `'` in escapeMermaidLabel.
      for (const [name, s] of skillsByNameRef.current) {
        if (escapeMermaidLabel(name) === label) {
          onSelect(s)
          return
        }
      }
    }

    root.addEventListener('click', handler)
    return () => root.removeEventListener('click', handler)
  }, [onSelect])

  const isOrphan = nodes.size === 1 && edges.length === 0

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal relmap-modal">
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
          <button className="btn btn-sm modal-close" onClick={onClose}>×</button>
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
              dangerouslySetInnerHTML={{ __html: svgHtml }}
            />
          ) : (
            <div className="empty-state" style={{ minHeight: 120 }}>
              <div className="spinner" />
            </div>
          )}
        </div>

        <div className="relmap-footer">
          <span className="relmap-src-label">Mermaid source</span>
          <pre className="relmap-src">{mermaidSrc}</pre>
        </div>
      </div>
    </div>
  )
}

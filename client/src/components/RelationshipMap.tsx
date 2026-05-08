import { useEffect, useRef, useState } from 'react'
import type { Skill } from '../types'
import mermaid from 'mermaid'

interface Props {
  skill: Skill
  allSkills: Skill[]
  onClose: () => void
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

// ─── Build the full ancestor + descendant chain ───────────────────────────────
function buildChain(root: Skill, allSkills: Skill[]): {
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

  // BFS forward: root and all descendants
  const visitedFwd = new Set<string>()
  const queueFwd: Skill[] = [root]
  while (queueFwd.length > 0) {
    const s = queueFwd.shift()!
    if (visitedFwd.has(s.name)) continue
    visitedFwd.add(s.name)
    nodes.set(s.name, s)
    for (const ref of s.references ?? []) {
      const target = byName.get(ref.name)
      if (target) {
        addEdge(s.name, ref.name, ref.source)
        if (!visitedFwd.has(ref.name)) queueFwd.push(target)
      } else {
        // broken ref — add as a placeholder node
        nodes.set(ref.name, {
          ...s, name: ref.name, type: 'skill', id: ref.name,
          description: '', health: { status: 'warn', issues: [] }, references: [],
        } as unknown as Skill)
        addEdge(s.name, ref.name, ref.source)
      }
    }
  }

  // BFS backward: ancestors (skills that reference any node we've found)
  const visitedBwd = new Set<string>()
  const queueBwd: Skill[] = allSkills.filter(s =>
    s.references?.some(r => nodes.has(r.name))
  )
  while (queueBwd.length > 0) {
    const s = queueBwd.shift()!
    if (visitedBwd.has(s.name)) continue
    visitedBwd.add(s.name)
    if (!nodes.has(s.name)) nodes.set(s.name, s)
    for (const ref of s.references ?? []) {
      if (nodes.has(ref.name)) {
        addEdge(s.name, ref.name, ref.source)
      }
    }
    // Find ancestors of this ancestor too
    const ancestors = allSkills.filter(a =>
      !visitedBwd.has(a.name) && a.references?.some(r => r.name === s.name)
    )
    queueBwd.push(...ancestors)
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

  // Node declarations with shapes
  for (const [name, skill] of nodes) {
    const id = sanitizeId(name)
    const label = escapeMermaidLabel(name)
    const [open, close] = typeShape(skill.type)
    lines.push(`  ${id}${open}"${label}"${close}`)
  }

  // Edges with style hints
  for (const edge of edges) {
    const from = sanitizeId(edge.from)
    const to = sanitizeId(edge.to)
    const arrow = edge.source === 'command' ? '-->' : '-.->'
    lines.push(`  ${from} ${arrow} ${to}`)
  }

  // Style: highlight the root node
  const rootId = sanitizeId(root.name)
  lines.push(`  style ${rootId} fill:#4a2d80,stroke:#9d6cf5,color:#e4e0f4,stroke-width:2px`)

  return lines.join('\n')
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function RelationshipMap({ skill, allSkills, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [svgHtml, setSvgHtml] = useState<string | null>(null)

  const { nodes, edges } = buildChain(skill, allSkills)
  const mermaidSrc = buildMermaid(skill, nodes, edges)

  useEffect(() => {
    let cancelled = false
    async function render() {
      try {
        const id = `mermaid-${Date.now()}`
        const { svg } = await mermaid.render(id, mermaidSrc)
        if (!cancelled) setSvgHtml(svg)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    }
    render()
    return () => { cancelled = true }
  }, [mermaidSrc])

  const isOrphan = nodes.size === 1 && edges.length === 0

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal relmap-modal">
        <div className="modal-header">
          <div>
            <div className="modal-title">{skill.name} — relationship map</div>
            <div className="modal-subtitle">
              {nodes.size} skill{nodes.size !== 1 ? 's' : ''} · {edges.length} edge{edges.length !== 1 ? 's' : ''} ·{' '}
              <span className="relmap-legend">
                <span className="relmap-legend-item">── direct &nbsp;</span>
                <span className="relmap-legend-item">·· body mention</span>
              </span>
            </div>
          </div>
          <button className="btn btn-sm modal-close" onClick={onClose}>×</button>
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
              <div>This skill has no references and is not referenced by any other skill.</div>
              <div className="relmap-orphan-sub">It stands alone — nothing leads into or out of it.</div>
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

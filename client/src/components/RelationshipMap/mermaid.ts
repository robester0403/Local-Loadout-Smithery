// Mermaid wiring: theme initialization plus the syntax generator that
// translates our GraphData into a flowchart source string.

import mermaid from 'mermaid'
import type { Skill } from '../../types'
import type { GraphEdge } from './graph'

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  // Kibana dark (EUI Amsterdam) palette so the graph blends with the app
  // shell. Keep these in sync with the tokens in App.css :root.
  themeVariables: {
    darkMode: true,
    background: '#1D1E24',
    mainBkg: '#25262E',
    nodeBorder: '#343741',
    clusterBkg: '#2D2E37',
    titleColor: '#FFFFFF',
    edgeLabelBackground: '#25262E',
    lineColor: '#81858F',
  },
  flowchart: { curve: 'basis', htmlLabels: true },
  // 'loose' is required so that future embedded interactivity (e.g. mermaid's
  // own click directives) would work — we don't currently emit any, since
  // navigation runs through DOM event delegation instead.
  securityLevel: 'loose',
})

export { mermaid }

// Convert an artifact name into a mermaid-safe node id. Lossy, but only used
// internally — we never reverse this back to the name from a DOM lookup.
export function sanitizeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_')
}

// Mermaid string labels can't contain double quotes. Replace with apostrophes
// so the visible label is still recognizable.
export function escapeMermaidLabel(name: string): string {
  return name.replace(/"/g, "'")
}

function typeShape(type: string): readonly [string, string] {
  switch (type) {
    case 'command':  return ['(', ')']    // rounded
    case 'subagent': return ['[[', ']]']  // subroutine
    default:         return ['[', ']']    // rectangle
  }
}

// Per-type fill / stroke using Elastic / Kibana semantic tokens. Subtle
// washes so the graph stays calm but each artifact type is recognizable at
// a glance. Kept in sync with App.css :root tokens and the legend swatches
// (.relmap-shape-* / .relmap-type-*).
export const TYPE_COLORS: Record<string, { fill: string; stroke: string }> = {
  skill:    { fill: '#142A3D', stroke: '#36A2EF' },  // EUI primary blue
  command:  { fill: '#3A2230', stroke: '#F68FBE' },  // EUI accent pink
  subagent: { fill: '#3A3220', stroke: '#F3D371' },  // EUI warning amber
  mcp:      { fill: '#143733', stroke: '#7DDED8' },  // EUI success teal
}

export function buildMermaid(
  root: Skill,
  nodes: Map<string, Skill>,
  edges: GraphEdge[],
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

  // Per-type fills for every non-root node. The root gets its own override
  // below so it always reads as "selected" regardless of type.
  const rootId = sanitizeId(root.name)
  for (const [name, skill] of nodes) {
    const id = sanitizeId(name)
    if (id === rootId) continue
    const c = TYPE_COLORS[skill.type] ?? TYPE_COLORS.skill
    lines.push(`  style ${id} fill:${c.fill},stroke:${c.stroke},color:#e4e0f4,stroke-width:1.5px`)
  }

  // Highlight the root so the user always knows which artifact is centered.
  // Uses the EUI primary brighter than the standard skill fill so it always
  // pops, regardless of the root's own type colors.
  lines.push(`  style ${rootId} fill:#1F4E7A,stroke:#6FC0FF,color:#FFFFFF,stroke-width:2.5px`)

  return lines.join('\n')
}

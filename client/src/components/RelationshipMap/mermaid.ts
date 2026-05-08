// Mermaid wiring: theme initialization plus the syntax generator that
// translates our GraphData into a flowchart source string.

import mermaid from 'mermaid'
import type { Skill } from '../../types'
import type { GraphEdge } from './graph'

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

  // Highlight the root so the user always knows which artifact is centered.
  const rootId = sanitizeId(root.name)
  lines.push(`  style ${rootId} fill:#4a2d80,stroke:#9d6cf5,color:#e4e0f4,stroke-width:2px`)

  return lines.join('\n')
}

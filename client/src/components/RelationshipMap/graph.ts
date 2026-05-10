// Graph data model + traversal for the RelationshipMap.
//
// `buildChain` walks the loadout's reference graph from a single root in both
// directions (descendants via .references, ancestors by reverse-lookup), each
// pass bounded by a configurable depth and direction filter. Output is a flat
// node map plus deduplicated edge list — ready for rendering by mermaid.ts.

import type { Skill } from '../../types'

export type Direction = 'in' | 'out' | 'both'

export interface GraphEdge {
  from: string
  to: string
  source: string
}

export interface GraphData {
  nodes: Map<string, Skill>
  edges: GraphEdge[]
}

// Zoom bounds and step. Module-scope so hooks and components can share them
// without prop-drilling.
export const ZOOM_MIN = 0.2
export const ZOOM_MAX = 4
export const ZOOM_STEP = 0.2

export const DEPTH_OPTIONS: ReadonlyArray<{ label: string; value: number }> = [
  { label: '1', value: 1 },
  { label: '2', value: 2 },
  { label: '3', value: 3 },
  { label: 'All', value: Number.POSITIVE_INFINITY },
]

export const DIRECTION_OPTIONS: ReadonlyArray<{
  label: string
  value: Direction
  title: string
}> = [
  { label: '← In',   value: 'in',   title: 'Show only artifacts that reference this one' },
  { label: '↔ Both', value: 'both', title: 'Show both incoming and outgoing references' },
  { label: '→ Out',  value: 'out',  title: 'Show only artifacts this one references' },
]

export function buildChain(
  root: Skill,
  allSkills: Skill[],
  maxDepth: number,
  direction: Direction,
): GraphData {
  // Scope traversal to the root's account. The two ecosystems
  // (Claude Code under ~/.claude and Cursor under ~/.cursor) are independent;
  // a `morning-plan` in one is unrelated to a `morning-plan` in the other,
  // so name-based byName lookups must not cross accounts.
  const sameAccount = allSkills.filter(s => s.account === root.account)
  const byName = new Map(sameAccount.map(s => [s.name, s]))
  const nodes = new Map<string, Skill>()
  const edges: GraphEdge[] = []
  const edgeKeys = new Set<string>()

  function addEdge(from: string, to: string, source: string) {
    const key = `${from}→${to}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push({ from, to, source })
  }

  // Root is always included regardless of depth/direction so the user always
  // has a focal node, even at "← In, depth 0" or for orphans.
  nodes.set(root.name, root)

  if (direction === 'out' || direction === 'both') {
    expandForward(root, byName, nodes, addEdge, maxDepth)
  }
  if (direction === 'in' || direction === 'both') {
    expandBackward(root, sameAccount, byName, nodes, addEdge, maxDepth)
  }

  return { nodes, edges }
}

// BFS forward: follow each node's .references to descendants. Broken refs
// (names not in the inventory) get added as warning placeholders so the user
// can see the dangling edge without crashing the layout.
function expandForward(
  root: Skill,
  byName: Map<string, Skill>,
  nodes: Map<string, Skill>,
  addEdge: (from: string, to: string, source: string) => void,
  maxDepth: number,
): void {
  const visited = new Set<string>()
  const queue: Array<{ skill: Skill; depth: number }> = [{ skill: root, depth: 0 }]

  while (queue.length > 0) {
    const { skill, depth } = queue.shift()!
    if (visited.has(skill.name)) continue
    visited.add(skill.name)
    if (depth >= maxDepth) continue

    for (const ref of skill.references ?? []) {
      const target = byName.get(ref.name)
      if (target) {
        if (!nodes.has(target.name)) nodes.set(target.name, target)
        addEdge(skill.name, ref.name, ref.source)
        if (!visited.has(ref.name)) queue.push({ skill: target, depth: depth + 1 })
      } else {
        if (!nodes.has(ref.name)) nodes.set(ref.name, brokenRefPlaceholder(ref.name, skill))
        addEdge(skill.name, ref.name, ref.source)
      }
    }
  }
}

// BFS backward: any artifact whose .references hit something in our node set
// gets pulled in as an ancestor.
function expandBackward(
  root: Skill,
  allSkills: Skill[],
  byName: Map<string, Skill>,
  nodes: Map<string, Skill>,
  addEdge: (from: string, to: string, source: string) => void,
  maxDepth: number,
): void {
  const visited = new Set<string>([root.name])
  const queue: Array<{ name: string; depth: number }> = allSkills
    .filter(s => s.references?.some(r => r.name === root.name))
    .map(s => ({ name: s.name, depth: 1 }))

  while (queue.length > 0) {
    const { name, depth } = queue.shift()!
    if (visited.has(name)) continue
    visited.add(name)
    const ancestor = byName.get(name)
    if (!ancestor) continue
    if (!nodes.has(ancestor.name)) nodes.set(ancestor.name, ancestor)

    for (const ref of ancestor.references ?? []) {
      if (nodes.has(ref.name)) addEdge(ancestor.name, ref.name, ref.source)
    }
    if (depth >= maxDepth) continue

    for (const candidate of allSkills) {
      if (visited.has(candidate.name)) continue
      if (candidate.references?.some(r => r.name === ancestor.name)) {
        queue.push({ name: candidate.name, depth: depth + 1 })
      }
    }
  }
}

function brokenRefPlaceholder(name: string, neighbor: Skill): Skill {
  // Reuses neighbor as a structural template, then overrides identity fields.
  // The cast is necessary because Skill has many required fields we don't
  // care about for a placeholder — they're never read for broken refs.
  return {
    ...neighbor,
    name,
    type: 'skill',
    id: name,
    description: '',
    health: { status: 'warn', issues: [] },
    references: [],
  } as unknown as Skill
}

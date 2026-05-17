// Diagnostic / warning icons overlaid on graph nodes.
//
// After mermaid renders the SVG into the container, the hook walks each
// `.node` group and injects small flag icons in the top-right corner that
// mirror the badges shown in the main UI table (Health + Insight columns).
// A single shared HTML tooltip is appended to <body> and shown on hover via
// event delegation — that lets it escape the SVG / foreignObject clipping
// chain that would otherwise hide it.
//
// On every new svgHtml React swaps innerHTML and our injections are
// discarded automatically; the hook just re-attaches them.

import { useEffect, useMemo, useRef, type RefObject } from 'react'
import type { Skill } from '../../types'
import { escapeMermaidLabel } from './mermaid'

export interface NodeDiagnosticsOptions {
  containerRef: RefObject<HTMLElement | null>
  svgHtml: string | null
  allSkills: Skill[]
}

interface DiagnosticIcon {
  glyph: string
  title: string
  /** Used as the className suffix so each icon kind can be tinted in CSS. */
  kind: string
}

// Visible size of each flag badge in SVG user units.
const FLAG_W = 18
const FLAG_H = 18
const SVG_NS = 'http://www.w3.org/2000/svg'

export function useNodeDiagnostics({ containerRef, svgHtml, allSkills }: NodeDiagnosticsOptions) {
  // Stable lookup table so the effect doesn't rebuild it on every traversal.
  const skillsByNameRef = useRef<Map<string, Skill>>(new Map())
  skillsByNameRef.current = useMemo(
    () => new Map(allSkills.map(s => [s.name, s])),
    [allSkills],
  )

  useEffect(() => {
    const root = containerRef.current
    if (!root || !svgHtml) return
    const byName = skillsByNameRef.current

    const tip = createSharedTooltip()
    const attached = injectBadgesIntoNodes(root, byName)
    const svgEl = root.querySelector<HTMLElement>('.relmap-svg')
    const detachTipEvents = svgEl ? wireTooltipEvents(svgEl, tip) : () => {}

    return () => {
      detachTipEvents()
      tip.remove()
      attached.forEach(el => el.remove())
    }
  }, [containerRef, svgHtml])
}

// ─── DOM injection ───────────────────────────────────────────────────────────

function injectBadgesIntoNodes(
  root: HTMLElement,
  byName: ReadonlyMap<string, Skill>,
): Element[] {
  const attached: Element[] = []
  const nodes = root.querySelectorAll<SVGGElement>('.relmap-svg .node')
  nodes.forEach(node => {
    // Guard against double-render races. React replaces innerHTML between
    // renders so this normally can't be true, but cheap to check.
    if (node.querySelector(':scope > .relmap-node-flags')) return

    const skill = resolveSkillForNode(node, byName)
    if (!skill) return

    const icons = buildDiagnosticIcons(skill)
    if (icons.length === 0) return

    const corner = findNodeTopRight(node)
    if (!corner) return

    const wrap = renderFlagGroup(icons, corner)
    node.appendChild(wrap)
    attached.push(wrap)
  })
  return attached
}

function resolveSkillForNode(
  node: SVGGElement,
  byName: ReadonlyMap<string, Skill>,
): Skill | undefined {
  const labelEl = node.querySelector('.nodeLabel, foreignObject, .label, text')
  const label = (labelEl?.textContent ?? node.textContent ?? '').trim()
  if (!label) return undefined
  const direct = byName.get(label)
  if (direct) return direct
  // Names containing `"` were mapped to `'` for mermaid; reverse-match.
  for (const [name, s] of byName) {
    if (escapeMermaidLabel(name) === label) return s
  }
  return undefined
}

function renderFlagGroup(icons: DiagnosticIcon[], corner: { x: number; y: number }): SVGGElement {
  const wrap = document.createElementNS(SVG_NS, 'g') as SVGGElement
  wrap.setAttribute('class', 'relmap-node-flags')

  // Lay icons out right-to-left at the top-right corner, slightly above the
  // shape so they read as "badges" on the node.
  icons.forEach((icon, i) => {
    const fo = document.createElementNS(SVG_NS, 'foreignObject')
    fo.setAttribute('x', String(corner.x - FLAG_W - i * (FLAG_W - 2)))
    fo.setAttribute('y', String(corner.y - FLAG_H / 2))
    fo.setAttribute('width', String(FLAG_W))
    fo.setAttribute('height', String(FLAG_H))
    fo.setAttribute('class', 'relmap-node-flag-fo')

    const span = document.createElement('span')
    span.className = `relmap-node-flag relmap-node-flag-${icon.kind}`
    span.textContent = icon.glyph
    // Custom tooltip text stored on the element; the native `title` is
    // intentionally omitted so the browser's slow default doesn't compete.
    span.dataset.tipText = icon.title
    fo.appendChild(span)
    wrap.appendChild(fo)
  })
  return wrap
}

// ─── Shape geometry ──────────────────────────────────────────────────────────

// Locate the visible outline among the node group's direct geometry children
// and return its top-right corner in the .node group's local coord space.
//
// Two surprises make this non-trivial:
//   1. Mermaid renders some shapes (subroutines, paths) with their own
//      `transform` attribute. `getBBox()` reports intrinsic coords ignoring
//      transforms, so the raw bbox is the wrong place to anchor a badge.
//   2. Some node groups contain decorative inner shapes; the visible outline
//      is whichever has the greatest area.
//
// Returns null when no shape could be measured (zero-area, off-screen, etc.).
function findNodeTopRight(node: SVGGElement): { x: number; y: number } | null {
  const nodeCTM = node.getCTM()
  if (!nodeCTM) return null
  const nodeInverse = nodeCTM.inverse()

  // `:scope >` keeps us from accidentally picking up shapes inside nested
  // foreignObjects (e.g. the HTML label).
  const shapes = node.querySelectorAll<SVGGraphicsElement>(
    ':scope > rect, :scope > polygon, :scope > circle, :scope > ellipse, :scope > path',
  )

  let best: { x: number; y: number } | null = null
  let bestArea = 0
  for (const s of shapes) {
    let b: DOMRect
    try { b = s.getBBox() } catch { continue }
    const area = b.width * b.height
    if (area <= bestArea) continue
    const shapeCTM = s.getCTM()
    if (!shapeCTM) continue
    // shape's intrinsic coords → viewport (shapeCTM) → node-local (nodeInv)
    const shapeToNode = nodeInverse.multiply(shapeCTM)
    const tr = new DOMPoint(b.x + b.width, b.y).matrixTransform(shapeToNode)
    bestArea = area
    best = { x: tr.x, y: tr.y }
  }
  return best
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────

function createSharedTooltip(): HTMLDivElement {
  const tip = document.createElement('div')
  tip.className = 'relmap-node-flag-tip'
  tip.setAttribute('role', 'tooltip')
  tip.style.display = 'none'
  document.body.appendChild(tip)
  return tip
}

// Attach mouseover/mouseout delegation to the SVG container so we don't bind
// listeners to every flag individually. Returns the detach function.
function wireTooltipEvents(svgEl: HTMLElement, tip: HTMLDivElement): () => void {
  const asFlag = (t: EventTarget | null): HTMLElement | null => {
    if (!(t instanceof HTMLElement)) return null
    return t.classList.contains('relmap-node-flag') ? t : null
  }

  const onOver = (e: Event) => {
    const flag = asFlag(e.target)
    if (!flag) return
    const text = flag.dataset.tipText ?? ''
    if (!text) return
    tip.textContent = text
    positionTooltipAbove(tip, flag)
  }
  const onOut = (e: Event) => {
    if (!asFlag(e.target)) return
    tip.style.display = 'none'
  }
  svgEl.addEventListener('mouseover', onOver)
  svgEl.addEventListener('mouseout', onOut)
  return () => {
    svgEl.removeEventListener('mouseover', onOver)
    svgEl.removeEventListener('mouseout', onOut)
  }
}

function positionTooltipAbove(tip: HTMLDivElement, target: HTMLElement) {
  const r = target.getBoundingClientRect()
  // Make the tip measurable before reading its size.
  tip.style.display = 'block'
  tip.style.visibility = 'hidden'
  tip.style.top = '0'
  tip.style.left = '0'
  const tr = tip.getBoundingClientRect()

  const margin = 6
  let top = r.top - tr.height - margin
  let left = r.left + r.width / 2 - tr.width / 2
  if (left < margin) left = margin
  if (left + tr.width > window.innerWidth - margin) {
    left = window.innerWidth - margin - tr.width
  }
  // Flip below if there isn't room above.
  if (top < margin) top = r.bottom + margin
  tip.style.top = `${top}px`
  tip.style.left = `${left}px`
  tip.style.visibility = 'visible'
}

// ─── Icon catalog ────────────────────────────────────────────────────────────

function buildDiagnosticIcons(skill: Skill): DiagnosticIcon[] {
  const icons: DiagnosticIcon[] = []

  // Slash commands aren't auto-routed by progressive disclosure, so
  // description-quality warnings don't apply. Filter them out here as a
  // belt-and-braces guard against stale server-side health data.
  const issues = (skill.health?.issues ?? []).filter(i => {
    if (skill.type !== 'command') return true
    return !/description/i.test(i.message)
  })
  const hasError = issues.some(i => i.severity === 'error')
  const hasWarn = issues.some(i => i.severity === 'warn')
  if (hasError) {
    icons.push({
      glyph: '✗',
      kind: 'error',
      title: 'Errors: ' + issues.map(i => i.message).join('; '),
    })
  } else if (hasWarn) {
    icons.push({
      glyph: '⚠',
      kind: 'warn',
      title: 'Warnings: ' + issues.map(i => i.message).join('; '),
    })
  }

  if (skill.insight === 'removal-candidate') {
    icons.push({ glyph: '🚨', kind: 'removal', title: 'Removal candidate' })
  } else if (skill.insight === 'winner') {
    icons.push({ glyph: '✅', kind: 'winner', title: 'Earning its keep' })
  }
  if (skill.dormant) {
    icons.push({ glyph: '💤', kind: 'dormant', title: 'Dormant — not invoked in 90+ days' })
  }
  if (skill.bloat) {
    icons.push({ glyph: '📦', kind: 'bloat', title: 'Description bloat' })
  }
  if (skill.suggestedType) {
    icons.push({
      glyph: '🔀',
      kind: 'mismatch',
      title: `Possible misclassification — looks like a ${skill.suggestedType.suggested}`,
    })
  }
  return icons
}

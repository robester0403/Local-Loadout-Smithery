// Custom hooks for the RelationshipMap graph surface: mermaid render lifecycle,
// auto-fit + manual zoom, click-and-drag panning, and click/hover navigation.
// Each hook is focused on one concern so the orchestrating component reads as
// composition rather than 400 lines of imperative effects.
//
// Sibling modules:
//   nodeDiagnostics.ts — overlay warning badges + tooltips on rendered nodes

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import type { Skill } from '../../types'
import { mermaid, escapeMermaidLabel } from './mermaid'
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from './graph'

export { useNodeDiagnostics } from './nodeDiagnostics'

// ─── Mermaid render lifecycle ────────────────────────────────────────────────
//
// Takes a mermaidSrc, returns the rendered SVG markup, parsed natural
// dimensions (from the viewBox), and any error. Cancels in-flight renders
// when the source changes mid-render.
export interface RenderResult {
  svgHtml: string | null
  naturalDim: { w: number; h: number } | null
  error: string | null
}

export function useMermaidRender(mermaidSrc: string): RenderResult {
  const [svgHtml, setSvgHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const id = `mermaid-${Date.now()}`
        const { svg } = await mermaid.render(id, mermaidSrc)
        if (cancelled) return
        setSvgHtml(svg)
        setError(null)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => { cancelled = true }
  }, [mermaidSrc])

  // Natural size parsed from the viewBox attribute in the SVG markup. Doing
  // this synchronously from the string (rather than DOM-querying after mount)
  // lets the layout-driven wrapper size the SVG in the same render pass.
  const naturalDim = useMemo(() => {
    if (!svgHtml) return null
    const match = svgHtml.match(/viewBox\s*=\s*["']([^"']+)["']/)
    if (!match) return null
    const parts = match[1].split(/\s+/).map(Number)
    if (parts.length === 4 && parts.every(n => Number.isFinite(n))) {
      return { w: parts[2], h: parts[3] }
    }
    return null
  }, [svgHtml])

  return { svgHtml, naturalDim, error }
}

// ─── Zoom + auto-fit + manual fit ────────────────────────────────────────────
//
// Returns a zoom level (1 = natural size) plus controls. On every new svgHtml
// the auto-fit runs in useLayoutEffect so the wrapper is sized correctly
// before the browser paints — no flash of unfitted content.
export interface ZoomControls {
  zoom: number
  zoomIn: () => void
  zoomOut: () => void
  fitToScreen: () => void
}

const PADDING = 12
const SAFETY_BUFFER_PX = 1   // sub-pixel rounding cushion per side

export function useGraphZoom(
  graphRef: RefObject<HTMLDivElement | null>,
  naturalDim: { w: number; h: number } | null,
  svgHtml: string | null,
): ZoomControls {
  const [zoom, setZoom] = useState<number>(1)
  // Tracks the last svgHtml we auto-fit so we don't re-fight the user's
  // manual zoom on unrelated re-renders.
  const lastFitSvgRef = useRef<string | null>(null)

  const computeFit = useCallback((): number | null => {
    const el = graphRef.current
    if (!naturalDim || !el) return null
    const { width, height } = el.getBoundingClientRect()
    const availW = Math.max(40, width - (PADDING + SAFETY_BUFFER_PX) * 2)
    const availH = Math.max(40, height - (PADDING + SAFETY_BUFFER_PX) * 2)
    const fit = Math.min(availW / naturalDim.w, availH / naturalDim.h)
    return clamp(fit, ZOOM_MIN, ZOOM_MAX)
  }, [graphRef, naturalDim])

  useLayoutEffect(() => {
    if (!svgHtml || lastFitSvgRef.current === svgHtml) return
    lastFitSvgRef.current = svgHtml
    const fit = computeFit()
    if (fit !== null) setZoom(fit)
  }, [svgHtml, computeFit])

  const zoomIn = useCallback(
    () => setZoom(z => clamp(+(z + ZOOM_STEP).toFixed(2), ZOOM_MIN, ZOOM_MAX)),
    [],
  )
  const zoomOut = useCallback(
    () => setZoom(z => clamp(+(z - ZOOM_STEP).toFixed(2), ZOOM_MIN, ZOOM_MAX)),
    [],
  )
  const fitToScreen = useCallback(() => {
    const fit = computeFit()
    if (fit !== null) setZoom(fit)
  }, [computeFit])

  return { zoom, zoomIn, zoomOut, fitToScreen }
}

// ─── Click-and-drag panning ──────────────────────────────────────────────────
//
// Attaches mousedown to the scrollable container; mousemove/mouseup go on
// document so the drag follows the cursor anywhere. When the cursor moves
// more than DRAG_THRESHOLD_PX, we set a flag so the trailing click event is
// suppressed (otherwise releasing on a node would falsely navigate).
//
// Returns a `wasDragging` ref that the click handler should consult and
// reset before deciding whether to dispatch navigation.
const DRAG_THRESHOLD_PX = 5

export interface PanningHandle {
  wasDraggingRef: RefObject<boolean>
}

export function useGraphPanning(graphRef: RefObject<HTMLDivElement | null>): PanningHandle {
  const wasDraggingRef = useRef<boolean>(false)

  useEffect(() => {
    const el = graphRef.current
    if (!el) return

    let dragging = false
    let startX = 0
    let startY = 0
    let startScrollLeft = 0
    let startScrollTop = 0
    let maxDelta = 0

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return  // left-click only
      dragging = true
      startX = e.clientX
      startY = e.clientY
      startScrollLeft = el.scrollLeft
      startScrollTop = el.scrollTop
      maxDelta = 0
      el.classList.add('is-panning')
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      maxDelta = Math.max(maxDelta, Math.hypot(dx, dy))
      el.scrollLeft = startScrollLeft - dx
      el.scrollTop = startScrollTop - dy
    }

    const onMouseUp = () => {
      if (!dragging) return
      // Below threshold = treat as a normal click (e.g. tiny accidental jitter).
      // Above threshold = a real drag, so suppress the click that follows.
      wasDraggingRef.current = maxDelta > DRAG_THRESHOLD_PX
      dragging = false
      el.classList.remove('is-panning')
    }

    el.addEventListener('mousedown', onMouseDown)
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      el.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [graphRef])

  return { wasDraggingRef }
}

// ─── Click navigation + hover preview via DOM event delegation ───────────────
//
// One handler set wired to a stable outer container. Reads lookup data through
// refs so re-renders for unrelated state don't trigger handler re-attachment.
// Click is suppressed when the panning hook reports a drag just ended.
export interface NodeInteractionsOptions {
  containerRef: RefObject<HTMLDivElement | null>
  allSkills: Skill[]
  onSelect?: (skill: Skill) => void
  wasDraggingRef?: RefObject<boolean>
}

export function useNodeInteractions({
  containerRef,
  allSkills,
  onSelect,
  wasDraggingRef,
}: NodeInteractionsOptions) {
  const [hoveredName, setHoveredName] = useState<string | null>(null)

  const skillsByNameRef = useRef<Map<string, Skill>>(new Map())
  skillsByNameRef.current = useMemo(
    () => new Map(allSkills.map(s => [s.name, s])),
    [allSkills],
  )

  useEffect(() => {
    const root = containerRef.current
    if (!root) return

    function nameFromNode(node: Element): string | null {
      const labelEl = node.querySelector('.nodeLabel, foreignObject, .label, text')
      const label = (labelEl?.textContent ?? node.textContent ?? '').trim()
      if (!label) return null
      if (skillsByNameRef.current.has(label)) return label
      // Names containing `"` were mapped to `'` for mermaid; reverse-match.
      for (const name of skillsByNameRef.current.keys()) {
        if (escapeMermaidLabel(name) === label) return name
      }
      return null
    }

    const onClick = (e: MouseEvent) => {
      // Suppress click that follows a drag-pan.
      if (wasDraggingRef?.current) {
        wasDraggingRef.current = false
        return
      }
      if (!onSelect) return
      const target = e.target as Element | null
      const node = target?.closest('.node')
      if (!node) return
      const name = nameFromNode(node)
      if (!name) return
      const skill = skillsByNameRef.current.get(name)
      if (skill) onSelect(skill)
    }

    const onMouseOver = (e: MouseEvent) => {
      const target = e.target as Element | null
      const node = target?.closest('.node')
      if (!node) return
      setHoveredName(nameFromNode(node))
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
  }, [containerRef, onSelect, wasDraggingRef])

  return {
    hoveredName,
    skillsByNameRef,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

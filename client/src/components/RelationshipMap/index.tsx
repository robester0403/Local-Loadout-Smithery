// RelationshipMap — modal that shows a Mermaid graph of artifacts referenced
// by (or referencing) a focal skill, with depth/direction filtering, zoom,
// pan, fullscreen, and a hover-driven info rail.
//
// Composition only. Each concern lives in a focused module:
//   graph.ts       — graph traversal + types + zoom/depth/direction constants
//   mermaid.ts     — mermaid syntax generation + theme init
//   hooks.ts       — useMermaidRender, useGraphZoom, useGraphPanning,
//                    useNodeInteractions
//   parts.tsx      — small presentational subcomponents

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Skill } from '../../types'
import { type Direction, buildChain } from './graph'
import { buildMermaid } from './mermaid'
import {
  useGraphPanning,
  useGraphZoom,
  useMermaidRender,
  useNodeInteractions,
} from './hooks'
import {
  RelmapControls,
  RelmapFullscreenButton,
  RelmapInfoRail,
  RelmapTypeLegend,
  RelmapZoomToolbar,
} from './parts'

interface Props {
  skill: Skill
  allSkills: Skill[]
  onClose: () => void
  /**
   * Called when the user clicks a node in the rendered graph. Passing this
   * makes the map navigable — clicking switches the detail view to the chosen
   * artifact. Broken-ref placeholder nodes (skills that don't exist in
   * allSkills) are silently ignored.
   */
  onSelect?: (skill: Skill) => void
}

export default function RelationshipMap({ skill, allSkills, onClose, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<HTMLDivElement>(null)

  const [maxDepth, setMaxDepth] = useState<number>(2)
  const [direction, setDirection] = useState<Direction>('both')
  const [fullscreen, setFullscreen] = useState<boolean>(false)

  // ESC closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const { nodes, edges } = useMemo(
    () => buildChain(skill, allSkills, maxDepth, direction),
    [skill, allSkills, maxDepth, direction],
  )
  const mermaidSrc = useMemo(
    () => buildMermaid(skill, nodes, edges),
    [skill, nodes, edges],
  )

  const { svgHtml, naturalDim, error } = useMermaidRender(mermaidSrc)
  const { zoom, zoomIn, zoomOut, fitToScreen } = useGraphZoom(graphRef, naturalDim, svgHtml)

  // Panning must be wired before node interactions so the click handler can
  // consult its drag flag and skip navigation when the click trails a drag.
  const { wasDraggingRef } = useGraphPanning(graphRef)
  const { hoveredName, skillsByNameRef } = useNodeInteractions({
    containerRef,
    allSkills,
    onSelect,
    wasDraggingRef,
  })

  const isOrphan = nodes.size === 1 && edges.length === 0
  const railSkill: Skill =
    (hoveredName && skillsByNameRef.current.get(hoveredName)) || skill

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`modal relmap-modal ${fullscreen ? 'relmap-modal-fullscreen' : ''}`}>
        <Header
          rootName={skill.name}
          nodeCount={nodes.size}
          edgeCount={edges.length}
          onClose={onClose}
        />

        <RelmapControls
          direction={direction}
          onDirectionChange={setDirection}
          maxDepth={maxDepth}
          onDepthChange={setMaxDepth}
        />

        <RelmapTypeLegend />

        <div className="relmap-body" ref={containerRef}>
          <div className="relmap-graph-wrap">
            <RelmapFullscreenButton
              fullscreen={fullscreen}
              onToggle={() => setFullscreen(f => !f)}
            />

            <div className="relmap-graph" ref={graphRef}>
              <GraphContent
                isOrphan={isOrphan}
                error={error}
                svgHtml={svgHtml}
                naturalDim={naturalDim}
                zoom={zoom}
              />
            </div>

            {!isOrphan && !error && svgHtml && (
              <RelmapZoomToolbar
                zoom={zoom}
                onZoomIn={zoomIn}
                onZoomOut={zoomOut}
                onFit={fitToScreen}
              />
            )}
          </div>

          <RelmapInfoRail
            skill={railSkill}
            isHovering={hoveredName != null}
            isRoot={railSkill.name === skill.name}
          />
        </div>
      </div>
    </div>
  )
}

// ─── Header ──────────────────────────────────────────────────────────────────
interface HeaderProps {
  rootName: string
  nodeCount: number
  edgeCount: number
  onClose: () => void
}

function Header({ rootName, nodeCount, edgeCount, onClose }: HeaderProps) {
  return (
    <div className="modal-header">
      <div>
        <div className="modal-title">{rootName} — relationship map</div>
        <div className="modal-subtitle">
          {nodeCount} {nodeCount === 1 ? 'artifact' : 'artifacts'} ·{' '}
          {edgeCount} edge{edgeCount !== 1 ? 's' : ''} ·{' '}
          <span className="relmap-legend">
            <span className="relmap-legend-item">── direct &nbsp;</span>
            <span className="relmap-legend-item">·· body mention</span>
          </span>
        </div>
      </div>
      <button className="btn btn-sm modal-close" onClick={onClose} aria-label="Close">×</button>
    </div>
  )
}

// ─── Graph content (orphan / error / svg / spinner) ──────────────────────────
interface GraphContentProps {
  isOrphan: boolean
  error: string | null
  svgHtml: string | null
  naturalDim: { w: number; h: number } | null
  zoom: number
}

function GraphContent({ isOrphan, error, svgHtml, naturalDim, zoom }: GraphContentProps) {
  if (isOrphan) {
    return (
      <div className="relmap-orphan">
        <div className="relmap-orphan-icon">◉</div>
        <div>No relationships visible at the current depth and direction.</div>
        <div className="relmap-orphan-sub">
          Try increasing depth, switching direction, or this artifact is genuinely an island.
        </div>
      </div>
    )
  }
  if (error) return <div className="sr-form-error">{error}</div>
  if (!svgHtml) {
    return (
      <div className="empty-state" style={{ minHeight: 120 }}>
        <div className="spinner" />
      </div>
    )
  }
  return (
    <div
      className="relmap-svg"
      style={naturalDim ? { width: naturalDim.w * zoom, height: naturalDim.h * zoom } : undefined}
      dangerouslySetInnerHTML={{ __html: svgHtml }}
    />
  )
}

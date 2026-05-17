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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Skill } from '../../types'
import { updateSkillContent } from '../../api'
import { type Direction, buildChain } from './graph'
import { buildMermaid, escapeMermaidLabel } from './mermaid'
import {
  useGraphPanning,
  useGraphZoom,
  useMermaidRender,
  useNodeDiagnostics,
  useNodeInteractions,
} from './hooks'
import {
  RelmapControls,
  RelmapFullscreenButton,
  RelmapInfoRail,
  RelmapTypeLegend,
  RelmapZoomToolbar,
  type BodyJump,
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
  /** Called after an inline description/body edit succeeds. The parent both
   *  applies the patch to local state (so the change shows immediately) and
   *  kicks off a canonical refetch in the background. */
  onSkillChanged?: (id: string, patch: { description?: string; body?: string }) => void
}

export default function RelationshipMap({ skill, allSkills, onClose, onSelect, onSkillChanged }: Props) {
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

  // Overlay diagnostic / warning icons onto each rendered node so the same
  // signals shown in the main table's Health + Diag columns are visible here.
  useNodeDiagnostics({ containerRef, svgHtml, allSkills })

  // Freeze the rail on the focused root while an inline edit is active so a
  // stray hover doesn't replace the editor's context mid-edit.
  const [railEditing, setRailEditing] = useState(false)

  const isOrphan = nodes.size === 1 && edges.length === 0
  const railSkill: Skill = railEditing
    ? skill
    : (hoveredName && skillsByNameRef.current.get(hoveredName)) || skill

  // Set of every artifact name in the loadout. Used by the info rail to
  // highlight mentions inside descriptions. Stable across re-renders.
  const knownNames = useMemo<ReadonlySet<string>>(
    () => new Set(allSkills.map(s => s.name)),
    [allSkills],
  )

  // Body-mention click bridge: scroll the graph to the mentioned artifact's
  // node and dispatch a BodyJump so the rail's Body section auto-opens and
  // scrolls to that exact occurrence. Nonce ensures repeated clicks re-fire.
  const [bodyJump, setBodyJump] = useState<BodyJump | null>(null)
  const jumpToMention = useCallback((name: string, offset: number) => {
    const graphEl = graphRef.current
    if (graphEl) {
      const candidates = graphEl.querySelectorAll<SVGGElement>('.node')
      let target: SVGGElement | null = null
      for (const node of candidates) {
        const labelEl = node.querySelector('.nodeLabel, foreignObject, .label, text')
        const label = (labelEl?.textContent ?? node.textContent ?? '').trim()
        if (label === name || escapeMermaidLabel(name) === label) {
          target = node
          break
        }
      }
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
        // Brief flash so the user's eye lands on the right node.
        target.classList.add('relmap-node-flash')
        window.setTimeout(() => target?.classList.remove('relmap-node-flash'), 1400)
      }
    }
    setBodyJump(prev => ({ name, offset, nonce: (prev?.nonce ?? 0) + 1 }))
  }, [])

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`modal relmap-modal ${fullscreen ? 'relmap-modal-fullscreen' : ''}`}>
        <Header
          rootName={skill.name}
          nodeCount={nodes.size}
          edgeCount={edges.length}
          onClose={onClose}
        />

        <div className="relmap-toprow">
          <RelmapControls
            direction={direction}
            onDirectionChange={setDirection}
            maxDepth={maxDepth}
            onDepthChange={setMaxDepth}
          />
          <RelmapTypeLegend />
        </div>

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
            knownNames={knownNames}
            bodyJump={bodyJump}
            onJumpToMention={jumpToMention}
            onEditingChange={setRailEditing}
            onSaveDescription={async (next) => {
              await updateSkillContent(railSkill.id, { description: next })
              onSkillChanged?.(railSkill.id, { description: next })
            }}
            onSaveBody={async (next) => {
              await updateSkillContent(railSkill.id, { body: next })
              onSkillChanged?.(railSkill.id, { body: next })
            }}
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
          {edgeCount} edge{edgeCount !== 1 ? 's' : ''}
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
  // Imperative innerHTML so React leaves the SVG subtree alone after we set
  // it. With `dangerouslySetInnerHTML`, unrelated re-renders (hover state in
  // the parent, zoom changes) can cause React to re-apply the HTML, which
  // wipes any DOM we've injected into the rendered SVG — notably the
  // diagnostic flag badges added by useNodeDiagnostics.
  const svgRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!svgRef.current) return
    svgRef.current.innerHTML = svgHtml ?? ''
  }, [svgHtml])

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
  if (error) return <div className="form-error">{error}</div>
  if (!svgHtml) {
    return (
      <div className="empty-state" style={{ minHeight: 120 }}>
        <div className="spinner" />
      </div>
    )
  }
  return (
    <div
      ref={svgRef}
      className="relmap-svg"
      style={naturalDim ? { width: naturalDim.w * zoom, height: naturalDim.h * zoom } : undefined}
    />
  )
}

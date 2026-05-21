import fs from 'fs'
import type { Bundle } from './types'
import { resolveBundlePaths } from './paths'
import {
  endMarker,
  renderMapFile,
  renderTriggerBlock,
  startMarker,
  type ResolvedSkillRow,
} from './writer'

// Drift describes the gap between what SuperRouter believes it wrote and
// what's actually on disk. A user who hand-edits CLAUDE.md can put the
// trigger block in any of these states; we surface them so the UI can
// prompt for re-application instead of silently lying about the bundle
// being live.
export type DriftStatus =
  | 'ok'
  | 'file-missing'
  | 'block-missing'
  | 'markers-corrupted'
  | 'block-modified'
  | 'map-modified'

export interface DriftResult {
  bundleId: string
  status: DriftStatus
  details?: string
}

function readOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8')
  } catch {
    return null
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function detectDrift(bundle: Bundle, rows: ResolvedSkillRow[]): DriftResult {
  const paths = resolveBundlePaths(bundle)
  const top = readOrNull(paths.topFile)
  if (top === null) {
    return { bundleId: bundle.id, status: 'file-missing' }
  }

  const start = startMarker(bundle.id)
  const end = endMarker(bundle.id)
  const hasStart = top.includes(start)
  const hasEnd = top.includes(end)

  if (hasStart !== hasEnd) {
    return {
      bundleId: bundle.id,
      status: 'markers-corrupted',
      details: hasStart
        ? 'Start marker present but end marker missing'
        : 'End marker present but start marker missing',
    }
  }

  if (!hasStart) {
    return { bundleId: bundle.id, status: 'block-missing' }
  }

  const re = new RegExp(`${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}`)
  const actual = top.match(re)?.[0] ?? ''
  const expected = renderTriggerBlock(bundle, paths.mapRelative)
  if (actual !== expected) {
    return { bundleId: bundle.id, status: 'block-modified' }
  }

  // Trigger block matches; verify the map file the block points at.
  const map = readOrNull(paths.mapFile)
  if (map === null) {
    return {
      bundleId: bundle.id,
      status: 'map-modified',
      details: 'Map file missing',
    }
  }
  if (map !== renderMapFile(bundle, rows)) {
    return { bundleId: bundle.id, status: 'map-modified' }
  }

  return { bundleId: bundle.id, status: 'ok' }
}

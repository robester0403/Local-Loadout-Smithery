import { IconBulb } from '@tabler/icons-react'
import type { Diagnostic } from '../types'
import Tooltip from './Tooltip'

interface Props {
  diagnostics: Diagnostic[]
}

// LOC-95: amber-tier info badge for ambiguous-mention diagnostics. Renders
// nothing when there are no diagnostics — the row stays visually clean.
// Hover surfaces every diagnostic; the full suggestion text + matched
// context lives in the relationship-map rail and DetailDrawer.
export default function DiagnosticBadge({ diagnostics }: Props) {
  if (!diagnostics || diagnostics.length === 0) return null
  return (
    <Tooltip
      className="insight-tooltip"
      content={
        <>
          <span className="insight-tooltip-title insight-tooltip-bloat">
            {diagnostics.length} mention {diagnostics.length === 1 ? 'diagnostic' : 'diagnostics'}
          </span>
          {diagnostics.slice(0, 5).map((d, i) => (
            <span key={i} className="insight-tooltip-row">
              <code style={{ fontSize: 11 }}>{d.matched}</code>
            </span>
          ))}
          {diagnostics.length > 5 && (
            <span className="insight-tooltip-row">
              +{diagnostics.length - 5} more
            </span>
          )}
          <span className="insight-tooltip-hint">
            Open the relationship map for the full list and suggested fixes.
          </span>
        </>
      }
    >
      <span className="insight-badge insight-badge-bloat">
        <IconBulb size={14} stroke={1.75} aria-hidden /> {diagnostics.length}
      </span>
    </Tooltip>
  )
}

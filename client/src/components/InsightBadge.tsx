import {
  IconAlertOctagonFilled,
  IconArrowsShuffle,
  IconCircleCheckFilled,
  IconPackage,
  IconZzz,
} from '@tabler/icons-react'
import type { Insight, ClassificationResult, Skill } from '../types'
import CopyPromptButton from './CopyPromptButton'
import { generateFixRemovalCandidatePrompt } from '../prompts/fixRemovalCandidatePrompt'
import { generateFixDormantPrompt } from '../prompts/fixDormantPrompt'
import { generateReclassifyPrompt } from '../prompts/reclassifyPrompt'
import { useSettings } from '../hooks/useSettings'

interface Props {
  insight: Insight
  dormant: boolean
  activeDollars: number
  loadedDollars: number
  lastInvoked: string
  bloat: boolean
  descLen: number
  suggestedType?: ClassificationResult | null
  skill?: Skill
  onReclassify?: (skill: Skill) => void
}

function fmt(n: number): string {
  return '$' + n.toFixed(4)
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
}

export default function InsightBadge({ insight, dormant, activeDollars, loadedDollars, lastInvoked, bloat, descLen, suggestedType, skill, onReclassify }: Props) {
  const { flags } = useSettings()
  // `mismatch` is the only branch whose source data (suggestedType) doesn't
  // pass through reapplyThresholds, so we gate it here. The removal /
  // winner / dormant / bloat gates are already applied upstream via
  // reapplyThresholds → null/false for disabled flags, which short-circuits
  // the corresponding branches below naturally.
  const mismatchBadge = suggestedType && skill && flags.mismatch ? (
    <span className="insight-badge insight-badge-mismatch insight-has-tooltip">
      <IconArrowsShuffle size={14} stroke={1.75} aria-hidden />
      <span className="insight-tooltip">
        <span className="insight-tooltip-title insight-tooltip-mismatch">Possible misclassification</span>
        <span className="insight-tooltip-row">Looks like a <b>{suggestedType.suggested}</b></span>
        {suggestedType.cues.map((cue, i) => (
          <span key={i} className="insight-tooltip-row">{cue}</span>
        ))}
        <CopyPromptButton getPrompt={() => generateReclassifyPrompt(skill)} label="Reclassify with AI" />
        {onReclassify && !skill.name.includes(':') && (
          <button
            className="prompt-btn"
            onClick={e => { e.stopPropagation(); onReclassify(skill) }}
          >
            Apply: move to {suggestedType.suggested}s
          </button>
        )}
      </span>
    </span>
  ) : null

  const bloatBadge = bloat ? (
    <span className="insight-badge insight-badge-bloat insight-has-tooltip">
      <IconPackage size={14} stroke={1.75} aria-hidden />
      <span className="insight-tooltip">
        <span className="insight-tooltip-title insight-tooltip-bloat">Description bloat</span>
        <span className="insight-tooltip-row">Description: <b>{descLen} chars</b> (limit: 150)</span>
        <span className="insight-tooltip-hint">Long descriptions cost tokens every turn. Trim to under 150 chars.</span>
      </span>
    </span>
  ) : null

  if (insight === 'removal-candidate') {
    return (
      <>
        <span className="insight-badge insight-badge-removal insight-has-tooltip">
          <IconAlertOctagonFilled size={14} aria-hidden />
          <span className="insight-tooltip">
            <span className="insight-tooltip-title insight-tooltip-removal">Removal candidate</span>
            <span className="insight-tooltip-row">Loaded cost: <b>{fmt(loadedDollars)}</b></span>
            <span className="insight-tooltip-row">Active cost: <b>{fmt(activeDollars)}</b> — never invoked</span>
            <span className="insight-tooltip-hint">Paying context tax every turn with no return</span>
            {skill && <CopyPromptButton getPrompt={() => generateFixRemovalCandidatePrompt(skill)} />}
          </span>
        </span>
        {bloatBadge}
        {mismatchBadge}
      </>
    )
  }

  if (insight === 'winner') {
    return (
      <>
        <span className="insight-badge insight-badge-winner insight-has-tooltip">
          <IconCircleCheckFilled size={14} aria-hidden />
          <span className="insight-tooltip">
            <span className="insight-tooltip-title insight-tooltip-winner">Earning its keep</span>
            <span className="insight-tooltip-row">Active cost: <b>{fmt(activeDollars)}</b></span>
            <span className="insight-tooltip-row">Loaded cost: <b>{fmt(loadedDollars)}</b></span>
            <span className="insight-tooltip-hint">High loaded cost AND actively used</span>
          </span>
        </span>
        {bloatBadge}
        {mismatchBadge}
      </>
    )
  }

  if (dormant) {
    const days = lastInvoked ? daysSince(lastInvoked) : null
    return (
      <>
        <span className="insight-badge insight-badge-dormant insight-has-tooltip">
          <IconZzz size={14} stroke={1.75} aria-hidden />
          <span className="insight-tooltip">
            <span className="insight-tooltip-title insight-tooltip-dormant">Dormant</span>
            {days !== null && (
              <span className="insight-tooltip-row">Last invoked: <b>{days} days ago</b></span>
            )}
            <span className="insight-tooltip-row">Loaded cost: <b>{fmt(loadedDollars)}</b></span>
            <span className="insight-tooltip-hint">Not invoked in 90+ days</span>
            {skill && <CopyPromptButton getPrompt={() => generateFixDormantPrompt(skill)} />}
          </span>
        </span>
        {bloatBadge}
        {mismatchBadge}
      </>
    )
  }

  if (bloat || mismatchBadge) {
    return <>{bloatBadge}{mismatchBadge}</>
  }

  return null
}

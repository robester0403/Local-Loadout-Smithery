import type { Insight, ClassificationResult } from '../types'

interface Props {
  insight: Insight
  dormant: boolean
  activeDollars: number
  loadedDollars: number
  lastInvoked: string
  bloat: boolean
  descLen: number
  suggestedType?: ClassificationResult | null
}

function fmt(n: number): string {
  return '$' + n.toFixed(4)
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
}

export default function InsightBadge({ insight, dormant, activeDollars, loadedDollars, lastInvoked, bloat, descLen, suggestedType }: Props) {
  const mismatchBadge = suggestedType ? (
    <span className="insight-badge insight-has-tooltip">
      🔀
      <span className="insight-tooltip">
        <span className="insight-tooltip-title insight-tooltip-mismatch">Possible misclassification</span>
        <span className="insight-tooltip-row">Looks like a <b>{suggestedType.suggested}</b></span>
        {suggestedType.cues.map((cue, i) => (
          <span key={i} className="insight-tooltip-row">{cue}</span>
        ))}
        <span className="insight-tooltip-hint">Check the drawer to review or reclassify.</span>
      </span>
    </span>
  ) : null

  const bloatBadge = bloat ? (
    <span className="insight-badge insight-has-tooltip">
      📦
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
        <span className="insight-badge insight-has-tooltip">
          🚨
          <span className="insight-tooltip">
            <span className="insight-tooltip-title insight-tooltip-removal">Removal candidate</span>
            <span className="insight-tooltip-row">Loaded cost: <b>{fmt(loadedDollars)}</b></span>
            <span className="insight-tooltip-row">Active cost: <b>{fmt(activeDollars)}</b> — never invoked</span>
            <span className="insight-tooltip-hint">Paying context tax every turn with no return</span>
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
        <span className="insight-badge insight-has-tooltip">
          ✅
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
        <span className="insight-badge insight-has-tooltip">
          💤
          <span className="insight-tooltip">
            <span className="insight-tooltip-title insight-tooltip-dormant">Dormant</span>
            {days !== null && (
              <span className="insight-tooltip-row">Last invoked: <b>{days} days ago</b></span>
            )}
            <span className="insight-tooltip-row">Loaded cost: <b>{fmt(loadedDollars)}</b></span>
            <span className="insight-tooltip-hint">Not invoked in 90+ days</span>
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

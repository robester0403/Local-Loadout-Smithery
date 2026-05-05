import type { HealthResult, Skill } from '../types'
import CopyPromptButton from './CopyPromptButton'
import { generateFixHealthPrompt } from '../prompts/fixHealthPrompt'

const ICONS: Record<string, string> = {
  ok: '✓',
  warn: '⚠',
  error: '✗',
}

interface Props {
  health: HealthResult
  skill?: Skill
}

export default function HealthBadge({ health, skill }: Props) {
  const { status, issues } = health

  if (status === 'ok') {
    return <span className="health-badge health-ok" title="No issues">{ICONS.ok}</span>
  }

  return (
    <span className={`health-badge health-${status} health-has-tooltip`}>
      {ICONS[status]} {issues.length}
      <span className="health-tooltip">
        {issues.map((issue, i) => (
          <span key={i} className={`health-tooltip-item health-tooltip-${issue.severity}`}>
            <span className="health-tooltip-icon">{issue.severity === 'error' ? '✗' : '⚠'}</span>
            {issue.message}
          </span>
        ))}
        {skill && (
          <CopyPromptButton getPrompt={() => generateFixHealthPrompt(skill)} />
        )}
      </span>
    </span>
  )
}

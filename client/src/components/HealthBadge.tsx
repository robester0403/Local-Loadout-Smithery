import { IconAlertTriangle, IconCheck, IconX } from '@tabler/icons-react'
import type { HealthResult, HealthStatus, Skill } from '../types'
import CopyPromptButton from './CopyPromptButton'
import Tooltip from './Tooltip'
import { generateFixHealthPrompt } from '../prompts/fixHealthPrompt'
import { useSettings } from '../hooks/useSettings'

interface Props {
  health: HealthResult
  skill?: Skill
}

const STATUS_TO_FLAG = {
  ok: 'healthOk',
  warn: 'healthWarn',
  error: 'healthError',
} as const

function StatusIcon({ status, size = 14 }: { status: HealthStatus; size?: number }) {
  if (status === 'ok') return <IconCheck size={size} stroke={2} aria-hidden />
  if (status === 'error') return <IconX size={size} stroke={2} aria-hidden />
  return <IconAlertTriangle size={size} stroke={2} aria-hidden />
}

export default function HealthBadge({ health, skill }: Props) {
  const { flags } = useSettings()
  const { status, issues } = health

  // Honor per-state flags: disabled health states render nothing. The
  // underlying health.status doesn't change — this is purely a view gate.
  if (!flags[STATUS_TO_FLAG[status]]) return null

  if (status === 'ok') {
    return (
      <span className="health-badge health-ok" title="No issues">
        <StatusIcon status="ok" />
      </span>
    )
  }

  return (
    <Tooltip
      className="health-tooltip"
      content={
        <>
          {issues.map((issue, i) => (
            <span key={i} className={`health-tooltip-item health-tooltip-${issue.severity}`}>
              <span className="health-tooltip-icon">
                <StatusIcon status={issue.severity === 'error' ? 'error' : 'warn'} size={12} />
              </span>
              {issue.message}
            </span>
          ))}
          {skill && (
            <CopyPromptButton getPrompt={() => generateFixHealthPrompt(skill)} />
          )}
        </>
      }
    >
      <span className={`health-badge health-${status}`}>
        <StatusIcon status={status} /> {issues.length}
      </span>
    </Tooltip>
  )
}

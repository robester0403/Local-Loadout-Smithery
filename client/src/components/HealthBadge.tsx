import type { HealthResult } from '../types'

const ICONS: Record<string, string> = {
  ok: '✓',
  warn: '⚠',
  error: '✗',
}

export default function HealthBadge({ health }: { health: HealthResult }) {
  const { status, issues } = health

  if (status === 'ok') {
    return <span className="health-badge health-ok" title="No issues">{ICONS.ok}</span>
  }

  const tooltip = issues.map(i => `${i.severity === 'error' ? '✗' : '⚠'} ${i.message}`).join('\n')

  return (
    <span className={`health-badge health-${status}`} title={tooltip}>
      {ICONS[status]} {issues.length}
    </span>
  )
}

import type { SecurityFinding, FindingSeverity } from '../api'

interface Props {
  findings: SecurityFinding[]
  // When the user clicks an `info` URL row, route through this handler so the
  // host can show a confirm dialog before opening an external link. If
  // omitted, URLs render as plain text — safer default.
  onOpenUrl?: (url: string) => void
}

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  high: 'High risk',
  medium: 'Medium risk',
  info: 'Info',
}

const SEVERITY_ICON: Record<FindingSeverity, string> = {
  high: '⛔',
  medium: '⚠',
  info: 'ℹ',
}

const SEVERITY_BG: Record<FindingSeverity, string> = {
  high: 'var(--c-danger, #c75450)',
  medium: 'var(--c-warn, #c89b3a)',
  info: 'var(--border)',
}

const SEVERITY_FG: Record<FindingSeverity, string> = {
  high: '#fff',
  medium: '#1D1E24',
  info: 'var(--text-dim)',
}

export default function SecurityFindings({ findings, onOpenUrl }: Props) {
  if (findings.length === 0) {
    return (
      <div className="drawer-meta" style={{ color: 'var(--text-dim)', fontSize: 12 }}>
        No suspicious patterns detected. The scanner only catches known shapes —
        review the body yourself before trusting an unfamiliar skill.
      </div>
    )
  }
  return (
    <ul className="accordion-issue-list">
      {findings.map((f, i) => (
        <li key={i} className="accordion-issue">
          <span
            style={{
              display: 'inline-block',
              fontSize: 10,
              padding: '2px 6px',
              borderRadius: 3,
              background: SEVERITY_BG[f.severity],
              color: SEVERITY_FG[f.severity],
              marginRight: 8,
              minWidth: 70,
              textAlign: 'center',
            }}
          >
            {SEVERITY_ICON[f.severity]} {SEVERITY_LABEL[f.severity]}
          </span>
          <span style={{ flex: 1 }}>
            <div>{f.message}</div>
            {f.kind === 'url' && onOpenUrl ? (
              <button
                className="btn btn-sm"
                style={{ marginTop: 4, fontSize: 11 }}
                onClick={() => onOpenUrl(f.evidence)}
                title="Confirm before opening external links from a skill you don't fully trust"
              >
                Open with confirmation
              </button>
            ) : (
              <code style={{ fontSize: 11, color: 'var(--text-dim)', wordBreak: 'break-all' }}>
                {f.evidence}
              </code>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

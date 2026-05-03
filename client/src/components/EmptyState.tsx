interface Props {
  variant: 'loading' | 'empty' | 'error'
  message?: string
  onRetry?: () => void
}

export default function EmptyState({ variant, message, onRetry }: Props) {
  if (variant === 'loading') {
    return (
      <div className="empty-state">
        <div className="spinner" />
        <p>Scanning skill directories…</p>
      </div>
    )
  }

  if (variant === 'error') {
    return (
      <div className="empty-state">
        <span className="empty-icon">⚠</span>
        <p className="empty-title">Failed to load skills</p>
        <p className="empty-sub">{message}</p>
        {onRetry && (
          <button className="btn" onClick={onRetry}>Retry</button>
        )}
      </div>
    )
  }

  return (
    <div className="empty-state">
      <span className="empty-icon">◌</span>
      <p className="empty-title">No skills match your filters</p>
      <p className="empty-sub">Try clearing the search or adjusting the filters.</p>
    </div>
  )
}

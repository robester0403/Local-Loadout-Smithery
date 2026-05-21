interface Props {
  variant: 'loading' | 'empty' | 'error' | 'none-installed'
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

  // Distinct from `empty` (which means "your filters hid everything") — this
  // is "we couldn't find any loadout source on this machine at all."
  if (variant === 'none-installed') {
    return (
      <div className="empty-state">
        <span className="empty-icon">◌</span>
        <p className="empty-title">No loadout sources found</p>
        <p className="empty-sub">
          Loadout Smithery scans <code>~/.claude/</code> (and any <code>~/.claude-*</code>
          {' '}variants), <code>~/.cursor/</code>, and <code>~/.codex/</code>. None of those
          {' '}directories exist on this host yet. Install Claude Code, Cursor, or Codex
          {' '}CLI and create at least one skill to populate the inventory.
        </p>
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

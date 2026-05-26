// In-app replacement for window.confirm. A single ConfirmProvider lives at
// the app root and owns the open/close state plus the resolver promise; any
// component reaches it via the `useConfirm()` hook:
//
//   const confirm = useConfirm()
//   if (!(await confirm({ message: 'Delete X?', destructive: true }))) return
//
// Rationale: window.confirm blocks the browser thread, can't be styled, and
// is one of the few UI bits this app still leaks to native. Replacing it
// gives consistent visuals (dark theme, monospace heading, .modal CSS),
// keyboard semantics (Esc cancels, Enter confirms when focus is on the
// confirm button), and a single audit point for every destructive action.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export interface ConfirmOptions {
  /** Main one-line prompt. The thing that ends with "?". */
  message: string
  /** Smaller subtext under the message — extra context the user should read
   *  before confirming. Renders only when non-empty. */
  detail?: string
  /** Custom header. Defaults to "Confirm" (or "Delete?" when destructive). */
  title?: string
  /** Confirm button label. Defaults to "Continue" (or "Delete" when destructive). */
  confirmLabel?: string
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string
  /** Switches the confirm button to the warn (red) variant and focuses the
   *  Cancel button by default so Enter doesn't auto-trigger a destructive
   *  action. */
  destructive?: boolean
}

type Resolver = (value: boolean) => void

interface PendingConfirm {
  options: ConfirmOptions
  resolve: Resolver
}

const ConfirmContext = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null)

// eslint-disable-next-line react-refresh/only-export-components
export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm called outside ConfirmProvider')
  return ctx
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null)

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>(resolve => {
      setPending({ options, resolve })
    })
  }, [])

  const settle = useCallback((value: boolean) => {
    setPending(prev => {
      if (prev) prev.resolve(value)
      return null
    })
  }, [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <ConfirmDialog
          options={pending.options}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      )}
    </ConfirmContext.Provider>
  )
}

interface ConfirmDialogProps {
  options: ConfirmOptions
  onConfirm: () => void
  onCancel: () => void
}

function ConfirmDialog({ options, onConfirm, onCancel }: ConfirmDialogProps) {
  const { destructive } = options
  const title = options.title ?? (destructive ? 'Delete?' : 'Confirm')
  const confirmLabel = options.confirmLabel ?? (destructive ? 'Delete' : 'Continue')
  const cancelLabel = options.cancelLabel ?? 'Cancel'

  // Focus the safer button by default — Cancel for destructive actions so
  // Enter doesn't trigger an accidental delete, Confirm otherwise so
  // common "yes please proceed" actions work without a mouse.
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const t = setTimeout(() => {
      if (destructive) cancelRef.current?.focus()
      else confirmRef.current?.focus()
    }, 0)
    return () => clearTimeout(t)
  }, [destructive])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      } else if (e.key === 'Enter') {
        // Only auto-confirm via Enter when focus is on a button inside the
        // dialog — prevents form submissions elsewhere from leaking in.
        const active = document.activeElement
        if (active === confirmRef.current) {
          e.preventDefault()
          onConfirm()
        } else if (active === cancelRef.current) {
          e.preventDefault()
          onCancel()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onConfirm, onCancel])

  return (
    <div className="modal-overlay" role="presentation" onClick={onCancel}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        style={{ maxWidth: 480 }}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <div className="modal-title" id="confirm-dialog-title">{title}</div>
          </div>
        </div>
        <div className="modal-section">
          <p style={{ whiteSpace: 'pre-line' }}>{options.message}</p>
          {options.detail && (
            <p style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 8, whiteSpace: 'pre-line' }}>
              {options.detail}
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button
            ref={cancelRef}
            className="btn"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            className={destructive ? 'btn btn-warn' : 'btn btn-primary'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

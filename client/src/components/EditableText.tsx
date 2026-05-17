// EditableText — inline edit affordance for a single text field.
//
// Renders the value with a small pencil button. Clicking the button (or the
// value itself) opens a textarea + Save/Cancel buttons. The component owns
// the draft state and dirty/loading/error transitions; the caller passes a
// pure `onSave(next)` that returns a promise. The component keeps editing
// mode open if the save throws so the user can correct and retry.
//
// Two visual variants:
//   - "line" — single-line input (used for descriptions)
//   - "block" — multi-line scrollable textarea (used for bodies)
//
// The caller controls whether the field can be edited at all (`editable`).
// When false, the component renders its children read-only.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

export type EditableVariant = 'line' | 'block'

interface Props {
  value: string
  variant: EditableVariant
  editable?: boolean
  /** Save handler. Reject to keep the editor open with an error banner. */
  onSave: (next: string) => Promise<void>
  /** Read-only render of the value (when not in edit mode). Lets callers
   *  highlight mentions, render markdown, etc. — falls back to plain text. */
  renderValue?: (value: string) => ReactNode
  /** Placeholder shown when value is empty (and not editing). */
  emptyText?: string
  /** Optional aria-label for the edit button. */
  label?: string
  /** Extra class names applied to the outer wrapper. */
  className?: string
  /** Fired when the editor opens. Surfaces "I am being edited" to ancestors
   *  that might otherwise reshuffle this component's context mid-edit. */
  onEditStart?: () => void
  /** Fired when the editor closes via save (success), cancel, or no-op save. */
  onEditEnd?: () => void
}

export default function EditableText({
  value,
  variant,
  editable = true,
  onSave,
  renderValue,
  emptyText = '',
  label = 'Edit',
  className,
  onEditStart,
  onEditEnd,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Reset draft whenever the upstream value changes while not editing — so a
  // refetch after save replaces the editor's view. While editing, leave the
  // draft alone: the user's in-flight edit takes precedence.
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus()
      // Place the cursor at the end so initial keystrokes append rather than
      // overwrite the field.
      const len = textareaRef.current.value.length
      textareaRef.current.setSelectionRange(len, len)
    }
  }, [editing])

  function startEdit() {
    if (!editable || saving) return
    setDraft(value)
    setError(null)
    setEditing(true)
    onEditStart?.()
  }

  function cancel() {
    setDraft(value)
    setError(null)
    setEditing(false)
    onEditEnd?.()
  }

  async function save() {
    if (saving) return
    const next = draft
    if (next === value) {
      setEditing(false)
      onEditEnd?.()
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(next)
      setEditing(false)
      onEditEnd?.()
    } catch (e) {
      setError((e as Error).message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // Keyboard: Cmd/Ctrl-Enter saves, Esc cancels. Plain Enter saves only in
  // the single-line variant — block variant keeps Enter for line breaks.
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); return }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void save(); return }
    if (e.key === 'Enter' && variant === 'line' && !e.shiftKey) { e.preventDefault(); void save() }
  }

  const wrapperClass = `editable editable-${variant}${editing ? ' is-editing' : ''}${className ? ' ' + className : ''}`

  if (editing) {
    return (
      <div className={wrapperClass}>
        <textarea
          ref={textareaRef}
          className="editable-textarea"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKey}
          rows={variant === 'line' ? 1 : 12}
          disabled={saving}
          spellCheck={false}
        />
        {error && <div className="form-error editable-error">{error}</div>}
        <div className="editable-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={save}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={cancel}
            disabled={saving}
          >
            Cancel
          </button>
          <span className="editable-hint">
            {variant === 'line' ? 'Enter to save · Esc to cancel' : '⌘/Ctrl + Enter to save · Esc to cancel'}
          </span>
        </div>
      </div>
    )
  }

  const isEmpty = value.length === 0
  return (
    <div className={wrapperClass}>
      <div className="editable-value">
        {isEmpty
          ? <span className="editable-empty">{emptyText || 'No value.'}</span>
          : renderValue
            ? renderValue(value)
            : value}
      </div>
      {editable && (
        <button
          type="button"
          className="editable-edit-btn"
          onClick={startEdit}
          title={label}
          aria-label={label}
        >
          ✎
        </button>
      )}
    </div>
  )
}

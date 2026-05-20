import { useState } from 'react'
import { IconSettings } from '@tabler/icons-react'
import SettingsModal from './SettingsModal'

// Sidebar entry point for the Settings modal. Kept as its own component so
// the sidebar stays presentational and so future variants (e.g. an in-app
// keyboard shortcut, a header gear icon) can mount the same modal without
// duplicating open/close state.
export default function SettingsPanel() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className="sidebar-settings-btn"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        <IconSettings size={14} stroke={1.75} aria-hidden />
        <span>Settings</span>
      </button>
      {open && <SettingsModal onClose={() => setOpen(false)} />}
    </>
  )
}

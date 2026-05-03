interface Props {
  checked: boolean
  onChange: (checked: boolean) => void
  title?: string
}

export default function ToggleSwitch({ checked, onChange, title }: Props) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      className={`toggle ${checked ? 'toggle-on' : 'toggle-off'}`}
      title={title}
      onClick={e => {
        e.stopPropagation() // don't open the drawer when clicking the toggle
        onChange(!checked)
      }}
    />
  )
}

import { useState, type ReactNode } from 'react'
import {
  useFloating,
  useHover,
  useFocus,
  useDismiss,
  useRole,
  useInteractions,
  offset,
  flip,
  shift,
  autoUpdate,
  safePolygon,
  FloatingPortal,
} from '@floating-ui/react'

interface Props {
  /** The trigger element. Hovered/focused to reveal the tooltip. */
  children: ReactNode
  /** The tooltip body — rendered through a portal at <body> so it can
   *  escape ancestor `overflow: hidden` (header, sidebar, table scroll). */
  content: ReactNode
  /** Optional class applied to the floating wrapper. Existing
   *  `.insight-tooltip` / `.health-tooltip` rules style the inner box. */
  className?: string
  /** Preferred placement. Defaults to 'top' to match the legacy CSS tooltip. */
  placement?: 'top' | 'bottom' | 'left' | 'right'
}

export default function Tooltip({ children, content, className, placement = 'top' }: Props) {
  const [open, setOpen] = useState(false)
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  })

  const hover = useHover(context, { move: false, handleClose: safePolygon() })
  const focus = useFocus(context)
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'tooltip' })
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role])

  return (
    <>
      <span
        ref={refs.setReference}
        {...getReferenceProps()}
        style={{ display: 'inline-flex', cursor: 'default' }}
      >
        {children}
      </span>
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={{ ...floatingStyles, zIndex: 1000 }}
            className={className}
            {...getFloatingProps()}
          >
            {content}
          </div>
        </FloatingPortal>
      )}
    </>
  )
}

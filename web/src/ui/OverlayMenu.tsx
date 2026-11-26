import type { ReactElement, ReactNode, RefObject } from 'react'

import { MenuPopover } from './MenuPopover'
import { useOverlayBack } from './useOverlayBack'

// OverlayMenu is the shared touch-menu popover: MenuPopover's placement and
// dismissal plus a history layer, so the platform back gesture peels the menu
// alone instead of leaving the session. `label` names the menu for assistive
// tech, `header` rides MenuPopover's slot above the items. Callers mount it
// only while open.
export function OverlayMenu({
  anchorRef,
  onClose,
  label,
  header,
  children,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
  label: string
  header?: ReactNode
  children: ReactNode
}): ReactElement {
  useOverlayBack(onClose)
  return (
    <MenuPopover
      anchorRef={anchorRef}
      role="menu"
      aria-label={label}
      className="menu card"
      align="right"
      header={header}
      onClose={onClose}
    >
      {children}
    </MenuPopover>
  )
}

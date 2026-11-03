import type { ReactElement, ReactNode, RefObject } from 'react'

import { MenuPopover } from '../ui/MenuPopover'
import { useOverlayBack } from './useOverlayBack'

// OverlayMenu is the phone menus' shared popover: MenuPopover's placement and
// dismissal plus a history layer, so the platform back gesture peels the menu
// alone instead of leaving the session. Callers mount it only while open.
export function OverlayMenu({
  anchorRef,
  onClose,
  children,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
  children: ReactNode
}): ReactElement {
  useOverlayBack(onClose)
  return (
    <MenuPopover
      anchorRef={anchorRef}
      role="menu"
      className="menu card"
      align="right"
      onClose={onClose}
    >
      {children}
    </MenuPopover>
  )
}

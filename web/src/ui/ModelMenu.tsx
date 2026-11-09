import { useRef } from 'react'
import type { ReactElement } from 'react'

import type { CtlState } from '../api/types'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { MenuPopover } from './MenuPopover'
import { ModelMenuItems } from './ModelMenuItems'
import { OverlayMenu } from './OverlayMenu'
import { useModelMenu } from './useModelMenu'

// ModelMenu is the model chip both chat headers render, over the shared
// useModelMenu controller with ModelMenuItems as the body. The pointer class
// picks OverlayMenu against MenuPopover exactly like ModeMenu on the same
// screen; the touch branch keeps the span wrapper the mobile header's
// yielding rules target.
export function ModelMenu({
  sessionId,
  snap,
  onToast,
}: {
  sessionId: string
  snap: CtlState
  onToast: (text: string, level?: 'info' | 'error') => void
}): ReactElement {
  const menu = useModelMenu(sessionId, snap.model.key, onToast)
  const chipRef = useRef<HTMLButtonElement>(null)
  // read live rather than at import: tests stub the pointer class per render
  const touch = useMediaQuery('(pointer: coarse)')

  const chip = (
    <button
      ref={chipRef}
      type="button"
      className="badge accent model-chip"
      disabled={menu.busy}
      title="Switch model"
      aria-haspopup="menu"
      aria-expanded={menu.open}
      onClick={() => void menu.toggle()}
    >
      {snap.model.short || snap.model.key || 'model'}
    </button>
  )
  const items = (
    <ModelMenuItems
      models={menu.models}
      active={menu.active}
      currentKey={snap.model.key}
      onPick={(key) => void menu.pick(key)}
    />
  )

  // wrapper class and popover type are the touch branch's only deltas
  if (touch) {
    return (
      <span className="model-chip-wrap">
        {chip}
        {menu.open && (
          <OverlayMenu anchorRef={chipRef} onClose={menu.close}>
            {items}
          </OverlayMenu>
        )}
      </span>
    )
  }
  return (
    <div className="model-menu">
      {chip}
      {menu.open && (
        <MenuPopover anchorRef={chipRef} role="menu" className="menu card" onClose={menu.close}>
          {items}
        </MenuPopover>
      )}
    </div>
  )
}

import { useRef } from 'react'

import type { CtlState } from '../api/types'
import { MenuPopover } from '../ui/MenuPopover'
import { ModelMenuItems } from '../ui/ModelMenuItems'
import { useModelMenu } from '../ui/useModelMenu'

// ModelChip is the compact header model control: the short label only, no
// working spinner (the bottom status line owns that). Fetch, pick and busy
// state live in the shared useModelMenu controller, so the chip fetches once
// per open exactly like the desktop header menu. Items render through the
// shared grouped ModelMenuItems, and MenuPopover places the menu so Escape
// and an outside tap close it through the shared overlay rules.
export function ModelChip({
  sessionId,
  snap,
  onToast,
}: {
  sessionId: string
  snap: CtlState
  onToast: (text: string, level?: 'info' | 'error') => void
}) {
  const menu = useModelMenu(sessionId, snap.model.key, onToast)
  const chipRef = useRef<HTMLButtonElement>(null)

  return (
    <span className="model-chip-wrap">
      <button
        ref={chipRef}
        type="button"
        className="badge accent model-chip"
        disabled={menu.busy}
        title="Switch model"
        onClick={() => void menu.toggle()}
      >
        {snap.model.short || snap.model.key || 'model'}
      </button>
      {menu.open && (
        <MenuPopover
          anchorRef={chipRef}
          role="menu"
          className="menu card"
          align="right"
          onClose={menu.close}
        >
          <ModelMenuItems
            models={menu.models}
            active={menu.active}
            currentKey={snap.model.key}
            onPick={(key) => void menu.pick(key)}
          />
        </MenuPopover>
      )}
    </span>
  )
}

import { useRef } from 'react'

import type { CtlState } from '../api/types'
import { ModelMenuItems } from '../ui/ModelMenuItems'
import { useModelMenu } from '../ui/useModelMenu'
import { OverlayMenu } from '../ui/OverlayMenu'

// ModelChip is the compact header model control: the short label only, no
// working spinner (the bottom status line owns that). Fetch, pick and busy
// state live in the shared useModelMenu controller, so the chip fetches once
// per open exactly like the desktop header menu. Items render through the
// shared grouped ModelMenuItems, and OverlayMenu binds the menu to the shared
// overlay rules, so Escape, an outside tap and platform back all close it.
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
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={() => void menu.toggle()}
      >
        {snap.model.short || snap.model.key || 'model'}
      </button>
      {menu.open && (
        <OverlayMenu anchorRef={chipRef} onClose={menu.close}>
          <ModelMenuItems
            models={menu.models}
            active={menu.active}
            currentKey={snap.model.key}
            onPick={(key) => void menu.pick(key)}
          />
        </OverlayMenu>
      )}
    </span>
  )
}

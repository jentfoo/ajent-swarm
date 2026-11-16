import { useCallback, useRef, useState } from 'react'

import { describeError } from '../api/errors'
import { sessions as sessionAPI } from '../api/endpoints'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { MenuPopover } from './MenuPopover'
import { OverlayMenu } from './OverlayMenu'

// The permission gate's fixed upstream vocabulary, mode.set refuses anything
// else. Order matches ajent's own cycle so the menu reads as a progression.
const permissionModes = ['allow-read', 'auto', 'auto+write', 'allow-all', 'block-all']

// ModeMenu picks the permission level straight from the fixed upstream
// vocabulary through mode.set. A session without a gate hides the menu.
// Coarse pointers bind the open menu to history, so platform back closes it
// instead of leaving the session, fine pointers keep MenuPopover alone, where
// browser back belongs to navigation.
export function ModeMenu({
  sessionId,
  mode,
  onToast,
}: {
  sessionId: string
  mode: string
  onToast: (text: string, level?: 'info' | 'error') => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const chipRef = useRef<HTMLButtonElement>(null)
  // read live rather than at import: tests stub the pointer class per render
  const touch = useMediaQuery('(pointer: coarse)')

  const pick = useCallback(
    async (next: string) => {
      if (busy || next === mode) {
        setOpen(false)
        return
      }
      setBusy(true)
      try {
        await sessionAPI.setMode(sessionId, next)
        setOpen(false)
        // the permission event re-renders the chip from the stream
      } catch (err) {
        onToast(describeError(err, 'Mode change refused.'), 'error')
      } finally {
        setBusy(false)
      }
    },
    [busy, mode, sessionId, onToast],
  )

  if (mode === '') return null // no gate exists on this session

  // one item list feeds either surface's popover
  const items = permissionModes.map((m) => (
    <button key={m} type="button" role="menuitem" onClick={() => void pick(m)}>
      {m}
      {m === mode && <span className="badge ok">current</span>}
    </button>
  ))

  return (
    <div className="model-menu">
      <button
        ref={chipRef}
        type="button"
        className="badge mode-chip"
        disabled={busy}
        title="Permission mode"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        mode: {mode}
      </button>
      {open &&
        (touch ? (
          <OverlayMenu anchorRef={chipRef} onClose={() => setOpen(false)}>
            {items}
          </OverlayMenu>
        ) : (
          <MenuPopover
            anchorRef={chipRef}
            role="menu"
            className="menu card"
            onClose={() => setOpen(false)}
          >
            {items}
          </MenuPopover>
        ))}
    </div>
  )
}

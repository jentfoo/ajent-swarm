import { useRef, useState } from 'react'

import type { CtlState } from '../api/types'
import { MenuPopover } from '../ui/MenuPopover'
import { ToolRows } from './ToolRows'

// ToolsPanel is the desktop /tools surface: a popover beside the mode menu
// fed by the snapshot tools rows that stream end to end. Rows render through
// the shared ToolRows, this chrome owns placement and disclosure.
//
// The trigger carries the disclosure attributes its header neighbors do,
// advertising dialog rather than menu: checkbox rows are no menu items.
export function ToolsPanel({
  sessionId,
  snap,
  onToast,
}: {
  sessionId: string
  snap: CtlState
  onToast: (text: string, level?: 'info' | 'error') => void
}) {
  const [open, setOpen] = useState(false)
  const chipRef = useRef<HTMLButtonElement>(null)
  const rows = snap.tools ?? []

  return (
    <div className="tools-menu">
      <button
        ref={chipRef}
        type="button"
        className="badge tools-chip"
        title="Toggle tools"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        /tools
      </button>
      {open && (
        <MenuPopover
          anchorRef={chipRef}
          role="dialog"
          aria-label="Tools"
          className="menu card"
          onClose={() => setOpen(false)}
        >
          {rows.length === 0 && <span className="muted menu-empty">No toggleable tools.</span>}
          <ToolRows sessionId={sessionId} snap={snap} onToast={onToast} lockTooltips />
        </MenuPopover>
      )}
    </div>
  )
}

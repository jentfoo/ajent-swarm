import { useRef, useState } from 'react'

import type { CtlState } from '../api/types'
import { MenuPopover } from '../ui/MenuPopover'
import { toolsWidenOnly } from './toolRule'
import { useToolToggles } from './useToolToggles'

// ToolsPanel is the desktop /tools surface: a popover beside the mode menu
// fed by the snapshot tools rows that stream end to end. Toggles go through
// tools.set's shared intent machine (useToolToggles), so quick flips compose
// instead of clobbering while the stream lags. After the run's first
// dispatched prompt the apply rule is widen-only (toolRule.ts), so toggles
// that would disable render disabled with their reason instead of refusing
// as a surprise. The readOnly flag is permission metadata — every registered
// tool stays toggleable here, matching upstream's own picker.
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
  const widenOnly = toolsWidenOnly(snap)
  const { enabledOf, toggle } = useToolToggles(sessionId, rows, onToast)

  return (
    <div className="tools-menu">
      <button
        ref={chipRef}
        type="button"
        className="badge tools-chip"
        title="Toggle tools"
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
          {rows.map((row) => {
            const locked = widenOnly && row.enabled
            return (
              <label key={row.name} className={`tool-row ${locked ? 'disabled' : ''}`}>
                <input
                  type="checkbox"
                  checked={enabledOf(row)}
                  disabled={locked}
                  title={
                    locked
                      ? 'Widen-only after the first prompt: this toggle can only enable'
                      : undefined
                  }
                  onChange={() => toggle(row)}
                />
                <span className="switch-name">{row.name}</span>
                <span className="muted tool-source">{row.source}</span>
              </label>
            )
          })}
        </MenuPopover>
      )}
    </div>
  )
}

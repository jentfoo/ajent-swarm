import { useRef, useState } from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { CtlState, ToolState } from '../api/types'
import { MenuPopover } from '../ui/MenuPopover'

// ToolsPanel is the desktop /tools surface: a popover beside the mode menu
// fed by the snapshot tools rows that stream end to end. Toggles go through
// tools.set; after the run's first dispatched prompt the apply rule is
// widen-only, so toggles that would disable render disabled instead of
// refusing as a surprise. The readOnly flag is permission metadata — every
// registered tool stays toggleable here, matching upstream's own picker.
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
  // Widening only: before the run's first dispatched prompt any reshaping
  // goes; afterwards a toggle may just enable. Turns started plus completed
  // approximates "the model has seen a tool block".
  const widenOnly = snap.usage.turns > 0 || snap.running

  const apply = async (desired: ToolState[]) => {
    try {
      await sessionAPI.setTools(
        sessionId,
        desired.filter((r) => r.enabled).map((r) => r.name),
      )
      // the full-replacement tools event re-renders from the stream
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Tool change refused.', 'error')
    }
  }

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
                  checked={row.enabled}
                  disabled={locked}
                  title={
                    widenOnly && row.enabled
                      ? 'Widen-only after the first prompt: this toggle can only enable'
                      : undefined
                  }
                  onChange={() =>
                    void apply(
                      rows.map((r) => (r.name === row.name ? { ...r, enabled: !r.enabled } : r)),
                    )
                  }
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

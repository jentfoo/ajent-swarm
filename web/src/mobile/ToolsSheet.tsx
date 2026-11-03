import type { ReactElement } from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { CtlState, ToolState } from '../api/types'

// ToolsSheet is the pushed full-screen tools panel: snapshot rows with their
// sources, toggled through tools.set. Each toggle submits the complete desired
// set — a free replacement before the run's first prompt, enable-only after,
// where upstream keeps names left out unchanged and refusals surface as toasts.
// The readOnly flag is permission metadata, never a toggle lock; rows an
// already-dispatched run cannot release render disabled like on desktop.
export function ToolsSheet({
  sessionId,
  snap,
  open,
  onClose,
  onToast,
}: {
  sessionId: string
  snap: CtlState
  open: boolean
  onClose: () => void
  onToast: (text: string, level?: 'info' | 'error') => void
}): ReactElement | null {
  if (!open) return null

  const rows = snap.tools ?? []
  // Widening only once the run dispatched a prompt; the desktop panel derives
  // this identically so both surfaces agree at every breakpoint.
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
    <div className="pushed-screen" role="dialog" aria-label="Tools">
      <header className="pushed-header">
        <button type="button" onClick={onClose}>
          ← Back
        </button>
        <h2>Tools</h2>
      </header>
      <p className="muted tools-hint">
        Toggles apply through the session's own /tools rule: everything can be reshaped before the
        first prompt, then only enabled.
      </p>
      <div className="tool-rows">
        {rows.length === 0 && <p className="muted">No toggleable tools.</p>}
        {rows.map((row) => {
          const locked = widenOnly && row.enabled
          return (
            <label key={row.name} className={`tool-row ${locked ? 'disabled' : ''}`}>
              <input
                type="checkbox"
                checked={row.enabled}
                disabled={locked}
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
      </div>
    </div>
  )
}

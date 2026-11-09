import type { ReactElement } from 'react'

import type { CtlState } from '../api/types'
import { toolsWidenOnly } from '../session/toolRule'
import { useToolToggles } from '../session/useToolToggles'
import { PushedScreen } from './PushedScreen'

// ToolsScreen is the pushed full-screen tools panel: snapshot rows with their
// sources, toggled through tools.set's shared intent machine
// (useToolToggles), so quick flips compose and settle from the next tools
// event. Each toggle submits the complete desired set, a free replacement
// before the run's first prompt, enable-only after, where upstream keeps
// names left out unchanged and refusals surface as toasts. The readOnly flag
// is permission metadata, never a toggle lock, rows an already-dispatched run
// cannot release render disabled like on desktop.
export function ToolsScreen({
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
  const rows = snap.tools ?? []
  const { enabledOf, toggle } = useToolToggles(sessionId, rows, onToast)

  if (!open) return null

  const widenOnly = toolsWidenOnly(snap)

  return (
    <PushedScreen title="Tools" onClose={onClose}>
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
                checked={enabledOf(row)}
                disabled={locked}
                onChange={() => toggle(row)}
              />
              <span className="switch-name">{row.name}</span>
              <span className="muted tool-source">{row.source}</span>
            </label>
          )
        })}
      </div>
    </PushedScreen>
  )
}

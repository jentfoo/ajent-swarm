import type { ReactElement } from 'react'

import type { CtlState } from '../api/types'
import { ToolRows } from '../session/ToolRows'
import { PushedScreen } from './PushedScreen'

// ToolsScreen is the pushed full-screen tools panel: snapshot rows with their
// sources render through the shared ToolRows, each toggle submitting the
// complete desired set, a free replacement before the run's first prompt,
// enable-only after, where upstream keeps names left out unchanged and
// refusals surface as toasts. The readOnly flag is permission metadata, never
// a toggle lock, rows an already-dispatched run cannot release render disabled
// like on desktop.
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
  if (!open) return null

  return (
    <PushedScreen title="Tools" onClose={onClose}>
      <p className="muted tools-hint">
        Toggles apply through the session's own /tools rule: everything can be reshaped before the
        first prompt, then only enabled.
      </p>
      <div className="tool-rows">
        {rows.length === 0 && <p className="muted">No toggleable tools.</p>}
        <ToolRows sessionId={sessionId} snap={snap} onToast={onToast} />
      </div>
    </PushedScreen>
  )
}

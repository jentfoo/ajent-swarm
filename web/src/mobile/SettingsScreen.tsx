import type { ReactElement } from 'react'

import { SettingsMenu } from '../session/SettingsMenu'

// SettingsScreen is the pushed full-screen agent settings panel for the
// session it was opened from: the shared settings.get/settings.set menu, no
// picker. Swarm's own global settings live on the /m/settings route instead.
export function SettingsScreen({
  sessionId,
  open,
  onClose,
}: {
  sessionId: string
  open: boolean
  onClose: () => void
}): ReactElement | null {
  if (!open) return null
  return (
    <div className="pushed-screen" role="dialog" aria-label="Agent settings">
      <header className="pushed-header">
        <button type="button" onClick={onClose}>
          ← Back
        </button>
        <h2>Agent settings</h2>
      </header>
      <div className="settings-screen-body">
        <SettingsMenu sessionId={sessionId} />
      </div>
    </div>
  )
}

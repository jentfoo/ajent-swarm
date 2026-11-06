import type { ReactElement } from 'react'

import { SettingsMenu } from '../session/SettingsMenu'
import { PushedScreen } from './PushedScreen'

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
    <PushedScreen title="Agent settings" onClose={onClose}>
      <div className="settings-screen-body">
        <SettingsMenu sessionId={sessionId} />
      </div>
    </PushedScreen>
  )
}

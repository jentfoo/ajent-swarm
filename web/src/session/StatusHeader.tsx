import type * as React from 'react'

import type { CtlState } from '../api/types'
import { sessionBusy } from '../state/eventApplier'
import { headerBadgeOf } from '../workspace/attention'
import { useWorkspace } from '../providers/workspace'
import { ModeMenu } from '../ui/ModeMenu'
import { ModelMenu } from '../ui/ModelMenu'
import { shortID } from './names'
import { useSessionLabel } from './useSessionLabel'
import { AgentSettingsMenu } from './AgentSettingsMenu'
import { StatusBadge } from './StatusBadge'
import { ToolsPanel } from './ToolsPanel'

// StatusHeader is the slim chrome above the transcript: identity (the shared
// listing label beside the short session id), the shared status badge and
// action buttons. Everything that reads at a glance (segments, context,
// queue, activity) lives in the status bar under the transcript. A running
// turn stops from the composer's Stop button, sessions exit from the
// sessions tab, so this header never tears one down. The ☰ here carries this
// session's agent settings.
export function StatusHeader({
  sessionId,
  snap,
  onToast,
  children,
}: {
  sessionId: string
  snap: CtlState
  onToast: (text: string, level?: 'info' | 'error') => void
  children?: React.ReactNode
}) {
  const working = sessionBusy(snap)
  // the badge reads the same derivation as the mobile header and the
  // switcher rows: needs-input outranks a turn still running behind it
  const { itemFor } = useWorkspace()
  // identity reads the swarm listing like the rail does, so a rename lands
  // with its refresh, and the short id rides beside any real label
  const label = useSessionLabel(sessionId)
  const short = shortID(sessionId)

  return (
    <div className="session-header">
      <h1 style={{ margin: 0, fontSize: 'inherit' }}>
        {label}
        {label !== short && <span className="muted mono header-session-id">{short}</span>}
      </h1>
      <StatusBadge status={headerBadgeOf(working, itemFor(sessionId))} />
      <ModeMenu sessionId={sessionId} mode={snap.permission} onToast={onToast} />
      <ToolsPanel sessionId={sessionId} snap={snap} onToast={onToast} />
      <ModelMenu sessionId={sessionId} snap={snap} onToast={onToast} />
      {children}
      <AgentSettingsMenu sessionId={sessionId} />
    </div>
  )
}

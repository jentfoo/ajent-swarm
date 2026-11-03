import { Link } from 'react-router'
import type { ReactNode } from 'react'

import { useSwarm } from '../providers/swarm'
import { useWorkspace } from '../providers/workspace'
import { ConnectionBanner } from '../ui/ConnectionBanner'
import { attendBadgeLabels } from '../workspace/attention'
import NotificationPrompt from './NotificationPrompt'

// MobileShell is the small-screen chrome: a slim top bar with the attention
// badge, plus the shared connection banner. The theme toggle and swarm's
// global settings live in the settings screen rather than here.
export default function MobileShell({ children }: { children: ReactNode }) {
  const { connection } = useSwarm()
  const { needsInputCount } = useWorkspace()

  return (
    <div className="app-shell mobile-shell">
      <header className="topbar mobile-topbar">
        <span className="spacer" />
        {needsInputCount > 0 && (
          <Link to="/" className="attend-badge" {...attendBadgeLabels(needsInputCount)}>
            {needsInputCount}
          </Link>
        )}
      </header>

      <ConnectionBanner connection={connection} />

      <NotificationPrompt />

      <main className="content mobile-content">{children}</main>
    </div>
  )
}

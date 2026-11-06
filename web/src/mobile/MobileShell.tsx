import { Link } from 'react-router'
import type { ReactNode } from 'react'

import { useSwarm } from '../providers/swarm'
import { useWorkspace } from '../providers/workspace'
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
          <Link
            to="/"
            className="attend-badge"
            title={`${needsInputCount} session(s) need input`}
            aria-label={`${needsInputCount} sessions need input`}
          >
            {needsInputCount}
          </Link>
        )}
      </header>

      {connection !== 'open' && (
        <div className="banner warn" role="status">
          {connection === 'connecting'
            ? 'Connecting to live updates…'
            : 'Live connection lost. Reconnecting…'}
        </div>
      )}

      <NotificationPrompt />

      <main className="content mobile-content">{children}</main>
    </div>
  )
}

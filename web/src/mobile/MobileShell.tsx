import { Link } from 'react-router'
import type { ReactNode } from 'react'

import { useSwarm } from '../providers/swarm'
import { useWorkspace } from '../providers/workspace'

// MobileShell is the small-screen chrome: a slim top bar with the launcher
// link and attention badge, plus the shared connection banner. Theme and
// density toggles live inside the settings screen rather than here.
export default function MobileShell({ children }: { children: ReactNode }) {
  const { connection } = useSwarm()
  const { needsInputCount } = useWorkspace()

  return (
    <div className="app-shell mobile-shell">
      <header className="topbar mobile-topbar">
        <Link to="/" className="brand" aria-label="ajent-swarm home">
          ajent-swarm
        </Link>
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

      <main className="content mobile-content">{children}</main>
    </div>
  )
}

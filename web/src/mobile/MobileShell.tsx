import { Link, useLocation } from 'react-router'
import type { ReactNode } from 'react'

import { useSwarm } from '../providers/swarm'
import { useWorkspace } from '../providers/workspace'
import { ConnectionBanner } from '../ui/ConnectionBanner'
import { attendBadgeLabels } from '../workspace/attention'
import NotificationPrompt from './NotificationPrompt'

// Two tabs where the desktop nav has three: MobileHome is already the session
// switcher, so one Sessions entry covers what Workspace plus Sessions do on
// desktop. Duplicated from shell/AppShell.tsx on purpose rather than coupling
// the two shells.

// MobileShell is the small-screen chrome: two destination tabs across the top
// bar beside the attention badge, plus the shared connection banner. The
// theme toggle and global settings live in the settings screen instead.
export default function MobileShell({ children }: { children: ReactNode }) {
  const { connection } = useSwarm()
  const { needsInputCount } = useWorkspace()
  const location = useLocation()

  // Sessions lights on home itself and session views below it; any /jobs path
  // lights Jobs. Desktop-only paths (/focused, /tile, /sessions) redirect home
  // in AuthGate before rendering, so no extra rules are needed.
  const sessionsRoute = location.pathname === '/' || location.pathname.startsWith('/s/')

  return (
    <div className="app-shell mobile-shell">
      <header className="topbar mobile-topbar">
        <nav aria-label="Primary">
          <Link to="/" className={sessionsRoute ? 'active' : ''}>
            Sessions
          </Link>
          <Link to="/jobs" className={location.pathname.startsWith('/jobs') ? 'active' : ''}>
            Jobs
          </Link>
        </nav>
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

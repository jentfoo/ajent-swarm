import { Link, useLocation } from 'react-router'
import type { ReactNode } from 'react'

import { useSwarm } from '../providers/swarm'
import { useWorkspace } from '../providers/workspace'
import { ConnectionBanner } from '../ui/ConnectionBanner'
import { attendBadgeLabels } from '../workspace/attention'
import NotificationPrompt from './NotificationPrompt'

// Same three tabs as the desktop nav in shell/AppShell.tsx, duplicated on
// purpose rather than coupling the two shells.
const workspacePaths = new Set(['/', '/focused', '/tile'])

// MobileShell is the small-screen chrome: three destination tabs across the
// top bar beside the attention badge, plus the shared connection banner. The
// theme toggle and global settings live in the settings screen instead.
export default function MobileShell({ children }: { children: ReactNode }) {
  const { connection } = useSwarm()
  const { needsInputCount } = useWorkspace()
  const location = useLocation()

  // active rules follow AppShell: /s/ lights Sessions off the /sessions
  // prefix, any /jobs path lights Jobs
  const workspaceRoute = workspacePaths.has(location.pathname)
  const sessionsRoute =
    location.pathname.startsWith('/sessions') || location.pathname.startsWith('/s/')

  return (
    <div className="app-shell mobile-shell">
      <header className="topbar mobile-topbar">
        <nav aria-label="Primary">
          <Link to="/" className={workspaceRoute ? 'active' : ''}>
            Workspace
          </Link>
          <Link to="/sessions" className={sessionsRoute ? 'active' : ''}>
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

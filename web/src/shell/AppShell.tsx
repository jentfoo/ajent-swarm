import { Link, useLocation, useNavigate } from 'react-router'
import type { ReactNode } from 'react'

import { useSwarm } from '../providers/swarm'
import { useWorkspace } from '../providers/workspace'
import { useAuth } from '../providers/auth'
import { ChildState } from '../api/types'
import type { SessionStatus } from '../api/types'
import { GlobalSettingsMenu } from './GlobalSettingsMenu'
import { ConnectionBanner } from '../ui/ConnectionBanner'

// reachableSession reports whether a pane can stream the session right now:
// connected (online) or active (reconnecting, e.g. just launched, or running).
// Shared with tile seeding so the Tile button tiles exactly what is live.
export function reachableSession(s: SessionStatus): boolean {
  return s.state === ChildState.Online || s.state === ChildState.Reconnecting || s.running
}

// Paths driving the workspace modes, where main also lets panes bleed under
// the chrome and the Workspace link highlights. Elsewhere the switcher would
// only navigate away.
const workspacePaths = new Set(['/', '/focused', '/tile'])

// AppShell is the desktop chrome, mounted only above the breakpoint; AuthGate
// swaps in MobileShell below it, so no phone-width branches belong here. The
// workspace mode switch (workspace routes only) and the attention badge live
// here, the theme toggle sits beside them, and the hamburger opens swarm's
// global settings; per-session agent settings ride each session's own chrome.
export default function AppShell({ children }: { children: ReactNode }) {
  const { sessions, connection, theme, setTheme } = useSwarm()
  const {
    needsInputCount,
    profile,
    setMode,
    notificationPermission: permission,
    requestNotifications,
  } = useWorkspace()
  const auth = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const workspaceRoute = workspacePaths.has(location.pathname)
  // session views live at /s/, off the /sessions prefix, but light its link
  const sessionsRoute =
    location.pathname.startsWith('/sessions') || location.pathname.startsWith('/s/')

  const switchMode = (mode: 'focused' | 'tile') => {
    setMode(mode)
    if (mode === 'tile') {
      // tiling is a verb: every reachable session lands in its own pane
      const live = sessions.filter(reachableSession).map((s) => encodeURIComponent(s.sessionId))
      navigate(live.length > 0 ? `/tile?open=${live.join(',')}` : '/tile')
      return
    }
    navigate('/focused')
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <nav>
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
        {workspaceRoute && (
          <div className="ws-switcher" role="group" aria-label="Workspace mode">
            <button
              type="button"
              className={profile.mode === 'focused' ? 'active' : ''}
              aria-pressed={profile.mode === 'focused'}
              onClick={() => switchMode('focused')}
            >
              Focused
            </button>
            <button
              type="button"
              className={profile.mode === 'tile' ? 'active' : ''}
              aria-pressed={profile.mode === 'tile'}
              onClick={() => switchMode('tile')}
            >
              Tile
            </button>
          </div>
        )}
        <span className="spacer" />
        {needsInputCount > 0 && (
          <button
            type="button"
            className="attend-badge"
            title={`${needsInputCount} session(s) need input`}
            aria-label={`${needsInputCount} sessions need input`}
            onClick={() => navigate('/focused')}
          >
            {needsInputCount}
          </button>
        )}
        {(permission === 'granted' || permission === 'default') && (
          <button
            type="button"
            className={permission === 'granted' ? 'bell on' : 'bell'}
            title={
              permission === 'granted'
                ? 'Desktop notifications are on'
                : 'Enable desktop notifications'
            }
            aria-label="Toggle desktop notifications"
            onClick={() => requestNotifications()}
          >
            {permission === 'granted' ? '🔔' : '🔕'}
          </button>
        )}
        <button
          type="button"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? '☾' : '☀'}
        </button>
        {/* swarm-level settings live here; per-session ones ride each chat */}
        <GlobalSettingsMenu />
        <span className="account-name muted">{auth.username}</span>
        <button type="button" onClick={() => void auth.logout()}>
          Sign out
        </button>
      </header>

      <ConnectionBanner connection={connection} />

      <main className={workspaceRoute ? 'content workspace-content' : 'content'}>{children}</main>
    </div>
  )
}

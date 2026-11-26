import { useLayoutEffect } from 'react'
import { Link, useLocation } from 'react-router'
import type { ReactNode } from 'react'

import { useKeyboardInset } from '../hooks/useKeyboardInset'
import { useSwarm } from '../providers/swarm'
import { useWorkspace } from '../providers/workspace'
import { ConnectionBanner } from '../ui/ConnectionBanner'
import { GearIcon } from '../ui/icons'
import { attendBadgeLabels, attendBadgePath } from '../workspace/attention'
import NotificationPrompt from './NotificationPrompt'

// Two tabs where the desktop nav has three: MobileHome is already the session
// switcher, so one Sessions entry covers what Workspace plus Sessions do on
// desktop. Duplicated from shell/AppShell.tsx on purpose rather than coupling
// the two shells.

// MobileShell is the small-screen chrome: two destination tabs across the top
// bar beside the attention badge and a settings shortcut, plus the shared
// connection banner. The theme toggle lives in the settings screen. Session
// screens go immersive: the top bar stands down and the session header carries
// the back control, the attention badge and the settings entries itself.
//
// It publishes --keyboard-inset once at :root so every mobile surface shares
// one value: .mobile-session pads its composer above the keyboard, and
// .sheet-backdrop lifts the fixed panels that would otherwise sit behind it.
export default function MobileShell({ children }: { children: ReactNode }) {
  const { connection } = useSwarm()
  const { needs, needsInputCount } = useWorkspace()
  const location = useLocation()
  const keyboardInset = useKeyboardInset()

  // one :root write covers every screen and portal; the layout effect lands
  // each animation step with the commit, and unmount clears it so a swap to
  // the desktop shell reads zero again
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--keyboard-inset', `${keyboardInset}px`)
    return () => {
      document.documentElement.style.removeProperty('--keyboard-inset')
    }
  }, [keyboardInset])

  // Sessions lights on home itself and read-only ended transcripts at /m/read/,
  // any /jobs path lights Jobs. Session screens render no bar at all, and the
  // remaining desktop-only paths (/focused, /tile, /sessions) redirect home in
  // AuthGate before rendering, so no extra rules are needed.
  const sessionsRoute = location.pathname === '/' || location.pathname.startsWith('/m/read/')
  const jobsRoute = location.pathname.startsWith('/jobs')
  // a session screen brings its own top chrome, the shell's bar would stack
  // a second one under the notch
  const immersive = location.pathname.startsWith('/s/')

  return (
    <div className={`app-shell mobile-shell${immersive ? ' immersive' : ''}`}>
      {!immersive && (
        <header className="topbar mobile-topbar">
          <nav aria-label="Primary">
            <Link
              to="/"
              className={sessionsRoute ? 'active' : ''}
              aria-current={sessionsRoute ? 'page' : undefined}
            >
              Sessions
            </Link>
            <Link
              to="/jobs"
              className={jobsRoute ? 'active' : ''}
              aria-current={jobsRoute ? 'page' : undefined}
            >
              Jobs
            </Link>
          </nav>
          <span className="spacer" />
          {needsInputCount > 0 && (
            <Link
              to={attendBadgePath(needs) ?? '/'}
              className="attend-badge"
              {...attendBadgeLabels(needsInputCount)}
            >
              {needsInputCount}
            </Link>
          )}
          <Link to="/m/settings" className="icon-btn" aria-label="Settings">
            <GearIcon />
          </Link>
        </header>
      )}

      <ConnectionBanner connection={connection} />

      <NotificationPrompt />

      <main className="content mobile-content">{children}</main>
    </div>
  )
}

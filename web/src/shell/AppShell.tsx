import { Link, useLocation } from 'react-router'
import type { ReactNode } from 'react'

import { useSwarm } from '../providers/swarm'
import { useAuth } from '../providers/auth'
import { useMediaQuery } from '../hooks/useMediaQuery'

// AppShell is the one chrome with two variants: the desktop pane-capable bar
// and a bottom navigation under the mobile breakpoint. The workspace mode
// switch (inbox versus tile) arrives in phase 09 on top of this shell.
export default function AppShell({ children }: { children: ReactNode }) {
  const { connection, theme, density, setTheme, setDensity } = useSwarm()
  const auth = useAuth()
  const mobile = useMediaQuery('(max-width: 48rem)')
  const location = useLocation()

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/" className="brand">
          ajent-swarm
        </Link>
        <nav>
          <Link to="/" className={location.pathname === '/' ? 'active' : ''}>
            Sessions
          </Link>
          <Link to="/jobs" className={location.pathname.startsWith('/jobs') ? 'active' : ''}>
            Jobs
          </Link>
        </nav>
        <span className="spacer" />
        <button
          type="button"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? '☾' : '☀'}
        </button>
        <button
          type="button"
          onClick={() => setDensity(density === 'cozy' ? 'compact' : 'cozy')}
          aria-label="Toggle density"
        >
          {density === 'cozy' ? '≡' : '☰'}
        </button>
        <span className="account-name muted">{auth.username}</span>
        <button type="button" onClick={() => void auth.logout()}>
          Sign out
        </button>
      </header>

      {connection !== 'open' && (
        <div className="banner warn" role="status">
          {connection === 'connecting'
            ? 'Connecting to live updates…'
            : 'Live connection lost. Reconnecting…'}
        </div>
      )}

      <main className="content">{children}</main>

      {mobile && (
        <nav className="mobile-nav">
          <Link to="/" className={location.pathname === '/' ? 'active' : ''}>
            Sessions
          </Link>
          <Link to="/jobs" className={location.pathname.startsWith('/jobs') ? 'active' : ''}>
            Jobs
          </Link>
        </nav>
      )}
    </div>
  )
}

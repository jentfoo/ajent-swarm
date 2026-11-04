import { Navigate, Route, Routes, useLocation } from 'react-router'
import type { ReactElement } from 'react'

import { useAuth } from './providers/auth'
import { useMediaQuery } from './hooks/useMediaQuery'
import AppShell from './shell/AppShell'
import MobileShell from './mobile/MobileShell'
import MobileHome from './mobile/MobileHome'
import MobileSessionScreen from './mobile/MobileSessionScreen'
import MobileSettings from './mobile/MobileSettings'
import EndedSessionScreen from './mobile/EndedSessionScreen'
import BootstrapScreen from './screens/BootstrapScreen'
import JobsHome from './screens/JobsHome'
import RunsHistory from './screens/RunsHistory'
import SessionView from './screens/SessionView'
import SessionsHome from './screens/SessionsHome'
import WorkspaceRoute from './screens/WorkspaceRoute'

// AuthGate renders the shell and routes only once signed in. The pre-auth
// states stand alone: bootstrap before any password exists, and a redirect to
// /login that keeps the current path and query so an expired session returns
// where it started.
//
// Two chrome variants host the same route ideas. Desktop keeps the pane-capable
// bar; mobile (phase 11) swaps in its own routes — launcher and switcher as
// the root view, a compact single-session screen, full-screen settings, and a
// read-only transcript for ended sessions.
export default function AuthGate(): ReactElement {
  const { status } = useAuth()
  const location = useLocation()
  const mobile = useMediaQuery('(max-width: 48rem)')

  if (status === 'loading') {
    return <div className="auth-screen muted">Loading…</div>
  }
  if (status === 'bootstrap') {
    return <BootstrapScreen />
  }
  if (status === 'anon') {
    // one string restores the whole deep link, and LoginScreen reads it back
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }

  if (mobile) {
    return (
      <MobileShell>
        <Routes>
          <Route path="/" element={<MobileHome />} />
          <Route path="/s/:sessionId" element={<MobileSessionScreen />} />
          <Route path="/m/read/:sessionId" element={<EndedSessionScreen />} />
          <Route path="/m/settings" element={<MobileSettings />} />
          <Route path="/jobs" element={<JobsHome />} />
          <Route path="/jobs/runs" element={<RunsHistory />} />
          <Route path="/jobs/:jobId" element={<JobsHome />} />
          {/* desktop deep links stay reachable: the workspace modes collapse
              into the single-session phone view */}
          <Route path="/focused" element={<Navigate to="/" replace />} />
          <Route path="/tile" element={<Navigate to="/" replace />} />
          <Route path="/sessions" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </MobileShell>
    )
  }

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<WorkspaceRoute />} />
        <Route path="/focused" element={<WorkspaceRoute mode="focused" />} />
        <Route path="/tile" element={<WorkspaceRoute mode="tile" />} />
        <Route path="/sessions" element={<SessionsHome />} />
        <Route path="/s/:sessionId" element={<SessionView />} />
        <Route path="/jobs" element={<JobsHome />} />
        <Route path="/jobs/runs" element={<RunsHistory />} />
        <Route path="/jobs/:jobId" element={<JobsHome />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}

import { Navigate, Route, Routes, useLocation } from 'react-router'
import type { ReactElement } from 'react'

import { useAuth } from './providers/auth'
import AppShell from './shell/AppShell'
import BootstrapScreen from './screens/BootstrapScreen'
import JobsPlaceholder from './screens/JobsPlaceholder'
import SessionView from './screens/SessionView'
import SessionsHome from './screens/SessionsHome'
import WorkspaceRoute from './screens/WorkspaceRoute'

// AuthGate renders the shell and routes only once signed in. The pre-auth
// states stand alone: bootstrap before any password exists, and a redirect to
// /login that keeps the current location so an expired session returns where
// it started. / renders the persisted workspace mode; /inbox and /tile
// deep-link one.
export default function AuthGate(): ReactElement {
  const { status } = useAuth()
  const location = useLocation()

  if (status === 'loading') {
    return <div className="auth-screen muted">Loading…</div>
  }
  if (status === 'bootstrap') {
    return <BootstrapScreen />
  }
  if (status === 'anon') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<WorkspaceRoute />} />
        <Route path="/inbox" element={<WorkspaceRoute mode="inbox" />} />
        <Route path="/tile" element={<WorkspaceRoute mode="tile" />} />
        <Route path="/sessions" element={<SessionsHome />} />
        <Route path="/s/:sessionId" element={<SessionView />} />
        <Route path="/jobs/*" element={<JobsPlaceholder />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}

import { BrowserRouter, Route, Routes } from 'react-router'

import { AuthProvider } from './providers/auth'
import { SwarmProvider } from './providers/swarm'
import { WorkspaceProvider } from './providers/workspace'
import AuthGate from './AuthGate'
import LoginScreen from './screens/LoginScreen'

// One component tree with two chrome variants, the router is the same under
// both, since mobile routes mirror the desktop tree. The workspace provider
// carries the layout profile and the shared attention model.
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <SwarmProvider>
          <WorkspaceProvider>
            <Routes>
              <Route path="/login" element={<LoginScreen />} />
              <Route path="*" element={<AuthGate />} />
            </Routes>
          </WorkspaceProvider>
        </SwarmProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}

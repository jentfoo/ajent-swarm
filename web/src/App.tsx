import { BrowserRouter, Route, Routes } from 'react-router'

import { AuthProvider } from './providers/auth'
import { SwarmProvider } from './providers/swarm'
import AuthGate from './AuthGate'
import LoginScreen from './screens/LoginScreen'

// One component tree with two chrome variants; the router is the same under
// both, since mobile routes mirror the desktop tree.
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <SwarmProvider>
          <Routes>
            <Route path="/login" element={<LoginScreen />} />
            <Route path="*" element={<AuthGate />} />
          </Routes>
        </SwarmProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}

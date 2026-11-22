import { BrowserRouter, Route, Routes } from 'react-router'

import { AuthProvider } from './providers/auth'
import { SwarmProvider } from './providers/swarm'
import { WorkspaceProvider } from './providers/workspace'
import { ChainDialog } from './workspace/ChainDialog'
import { QueueDialog } from './workspace/QueueDialog'
import { ChainEditorScreen } from './mobile/ChainScreens'
import { QueueScreen } from './mobile/QueueScreens'
import { mobileLayout, useMediaQuery } from './hooks/useMediaQuery'
import AuthGate from './AuthGate'
import LoginScreen from './screens/LoginScreen'

// One component tree with two chrome variants, the router is the same under
// both, since mobile routes mirror the desktop tree. The workspace provider
// carries the layout profile and the shared attention model, the chain and
// follow-up editors mount once above the routes so session swaps and layout
// switches never unmount them mid-edit: the desktop modal on wide screens,
// the pushed screens on phones.
function ChainSurfaces() {
  const mobile = useMediaQuery(mobileLayout)
  return (
    <>
      {mobile ? <ChainEditorScreen /> : <ChainDialog />}
      {mobile ? <QueueScreen /> : <QueueDialog />}
    </>
  )
}

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
            <ChainSurfaces />
          </WorkspaceProvider>
        </SwarmProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}

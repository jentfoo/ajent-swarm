import type { ReactElement } from 'react'

import type { SocketState } from '../stream/swarmStream'

// ConnectionBanner is the live-update notice both shells render under their
// chrome: quiet while the multiplexed stream is open, one warn line while
// connecting, lost or parked by a refused credential.
export function ConnectionBanner({ connection }: { connection: SocketState }): ReactElement | null {
  if (connection === 'open') return null
  return (
    <div className="banner warn" role="status">
      {connection === 'connecting'
        ? 'Connecting to live updates…'
        : connection === 'unauthorized'
          ? 'Signed out. Live updates resume after login.'
          : 'Live connection lost. Reconnecting…'}
    </div>
  )
}

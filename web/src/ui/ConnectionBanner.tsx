import type { ReactElement } from 'react'

import type { SocketState } from '../stream/swarmStream'

// ConnectionBanner is the live-update notice both shells render under their
// chrome: quiet while the multiplexed stream is open, one warn line while
// connecting or lost.
export function ConnectionBanner({ connection }: { connection: SocketState }): ReactElement | null {
  if (connection === 'open') return null
  return (
    <div className="banner warn" role="status">
      {connection === 'connecting'
        ? 'Connecting to live updates…'
        : 'Live connection lost. Reconnecting…'}
    </div>
  )
}

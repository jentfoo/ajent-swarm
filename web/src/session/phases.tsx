import type { SessionPhase } from '../stream/swarmStream'

// phaseText is the one sentence per transient session phase; every banner that
// explains why a session view has no live stream renders through it, so mobile
// and desktop never drift apart. Live and ended render their own chrome and
// answer empty.
export function phaseText(phase: SessionPhase): string {
  switch (phase) {
    case 'connecting':
      return 'Connecting to the session stream…'
    case 'resyncing':
      return 'Connection was interrupted; resnapshotting…'
    case 'lost':
      return 'The session is not reachable right now. It will reappear when its control socket serves again.'
    default:
      return ''
  }
}

// isTransientPhase marks the phases that show the shared banner and header
// badge; live and ended render their own chrome.
export function isTransientPhase(phase: SessionPhase): boolean {
  return phase !== 'live' && phase !== 'ended'
}

// PhaseBanner is the shared transient-phase banner both session surfaces
// render while the stream is not live.
export function PhaseBanner({ phase }: { phase: SessionPhase }) {
  if (!isTransientPhase(phase)) return null
  return (
    <div className="banner info" role="status">
      {phaseText(phase)}
    </div>
  )
}

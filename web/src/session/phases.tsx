import type { SessionPhase } from '../stream/swarmStream'

// phaseText is the one sentence per transient session phase, every banner that
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
// badge, live and ended render their own chrome.
export function isTransientPhase(phase: SessionPhase): boolean {
  return phase !== 'live' && phase !== 'ended'
}

// EndedBanner holds one ended-session warn banner's facts: whether any surface
// renders it, and the sentence it opens with.
export interface EndedBanner {
  show: boolean
  text: string // 'Session ended.' or 'Session ended: <reason>.'
}

// endedBanner is the one derivation both session surfaces consume for the
// ended banner, so trigger condition and copy cannot drift apart. A session
// that exited shows it even while the phase has not settled on 'ended'.
export function endedBanner(phase: SessionPhase, exitReason?: string): EndedBanner {
  return {
    show: phase === 'ended' || exitReason !== undefined,
    text: `Session ended${exitReason ? `: ${exitReason}` : ''}.`,
  }
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

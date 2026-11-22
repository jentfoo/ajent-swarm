import type { ReactElement } from 'react'

import { useSwarm } from '../providers/swarm'
import { useSessionNamer } from '../session/useSessionLabel'
import { reachableSession } from './TileWorkspace'

// chainPickerIntro is the one line above every chain target picker, desktop
// modal and mobile pushed screen alike.
export const chainPickerIntro = 'Pick the session that runs after this one:'

// ChainTargets lists the sessions a chain may deliver into: every reachable
// session except the parent itself. Both entry surfaces render it, the
// desktop settings menu inside its modal and mobile inside a pushed screen,
// so target picking stays one derivation.
export function ChainTargets({
  parentId,
  onPick,
  showEmpty = true,
}: {
  parentId: string
  onPick: (childId: string) => void
  // callers offering another path (a fresh-session launch) own their empty copy
  showEmpty?: boolean
}): ReactElement | null {
  const { sessions } = useSwarm()
  const nameFor = useSessionNamer()

  const targets = sessions.filter((s) => s.sessionId !== parentId && reachableSession(s))
  if (targets.length === 0) {
    return showEmpty ? <p className="muted">No other live sessions to chain into.</p> : null
  }
  return (
    <div className="chain-targets" role="list" aria-label="Chain target sessions">
      {targets.map((s) => (
        <button
          type="button"
          role="listitem"
          key={`${s.sessionId}:${s.pid ?? 0}`}
          className="chain-target-row"
          onClick={() => onPick(s.sessionId)}
        >
          <span className="rail-name">{nameFor(s.sessionId)}</span>
          <span className="muted mono">{s.workspace ? ` · ${s.workspace}` : ''}</span>
        </button>
      ))}
    </div>
  )
}

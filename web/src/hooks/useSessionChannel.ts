import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'

import type { SessionPhase } from '../stream/swarmStream'
import type { ApplierAction, AppliedSessionState } from '../state/eventApplier'
import { useSwarm } from '../providers/swarm'

// useSessionChannel pairs one session's reconciled state from the shared
// SessionStore with its stream phase. The store owns the subscription: views
// acquire and release it, recently viewed sessions stay warm, and several
// views of one session share one state object.
export function useSessionChannel(sessionId: string): {
  state: AppliedSessionState
  phase: SessionPhase
  // loadOlder pages one block of committed history older than what we hold,
  // answering whether a page arrived (false when the server ran dry).
  loadOlder: () => Promise<boolean>
  // dispatch feeds local actions (optimistic rows, locally answered dialogs)
  // through the same reducer the wire frames use.
  dispatch: (action: ApplierAction) => void
} {
  const { store, stream } = useSwarm()

  useEffect(() => store.acquire(sessionId), [store, sessionId])

  const state = useSyncExternalStore(
    useCallback((cb) => store.subscribeState(sessionId, cb), [store, sessionId]),
    useCallback(() => store.peek(sessionId), [store, sessionId]),
  )

  const phase = useSyncExternalStore(
    useCallback((cb) => stream.onSessionPhaseChange(sessionId, cb), [stream, sessionId]),
    useCallback(() => stream.sessionPhase(sessionId), [stream, sessionId]),
  )

  return useMemo(
    () => ({
      state,
      phase,
      loadOlder: () => store.loadOlder(sessionId),
      dispatch: (action: ApplierAction) => store.dispatch(sessionId, action),
    }),
    [store, sessionId, state, phase],
  )
}

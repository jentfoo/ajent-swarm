import { useCallback, useEffect, useReducer, useRef, useSyncExternalStore } from 'react'

import type { Entry } from '../api/types'
import { sessions as sessionAPI } from '../api/endpoints'
import { applierReducer, initialSessionState } from '../state/eventApplier'
import type { ApplierAction, AppliedSessionState } from '../state/eventApplier'
import type { SessionPhase } from '../stream/swarmStream'
import { usePoll } from './usePoll'
import { useSwarm } from '../providers/swarm'

// Page sizing for lazy older-history fetches; the server caps at 500.
const pageLimit = 200
const maxHealPages = 5

export interface SessionChannel {
  state: AppliedSessionState
  phase: SessionPhase
  // loadOlder pages one block of committed history older than what we hold,
  // answering whether a page arrived (false when the server ran dry).
  loadOlder: () => Promise<boolean>
  // dispatch feeds local actions (optimistic rows, locally answered dialogs)
  // through the same reducer the wire frames use.
  dispatch: (action: ApplierAction) => void
}

// useSessionChannel owns one session's reconciled state: it subscribes through
// the shared stream client, applies init and event frames with the one
// watermark rule, resnapshots poll-only facts (after each turn.end, on a slow
// timer, when the tab regains focus) and heals a chain left incomplete by a
// branch change through paged fetches or a full resync.
export function useSessionChannel(sessionId: string): SessionChannel {
  const { stream } = useSwarm()

  const [state, dispatch] = useReducer(applierReducer, undefined, initialSessionState)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    return stream.subscribe(sessionId, (frame) => {
      if (frame.type === 'init') {
        dispatch({ type: 'init', frame })
      } else if (frame.type === 'event') {
        dispatch({ type: 'event', event: frame.event })
      }
    })
  }, [stream, sessionId])

  const phase = useSyncExternalStore(
    useCallback((cb) => stream.onSessionPhaseChange(sessionId, cb), [stream, sessionId]),
    () => stream.sessionPhase(sessionId),
  )

  // Poll-only facts have no events; refresh by resnapshotting on a slow timer.
  const resnapshot = useCallback(async () => {
    try {
      const snap = await sessionAPI.snapshot(sessionId)
      dispatch({ type: 'snapshot', state: snap })
    } catch {
      // Unknown sessions flip the phase through error frames instead.
    }
  }, [sessionId])
  usePoll(resnapshot, 20_000)

  useEffect(() => {
    if (state.lastTurnEndAt === 0) return
    const timer = setTimeout(() => void resnapshot(), 250)
    return () => clearTimeout(timer)
  }, [state.lastTurnEndAt, resnapshot])

  // A branch change re-roots the visible chain to the head the event names.
  // When that chain is not already local, page older history back until it
  // roots or the server runs dry, then fall back to a full resync. Progress
  // tracks locally: reducer state may lag this async loop by a render.
  useEffect(() => {
    if (state.healTick === 0) return
    const start = stateRef.current
    if (start.chain.ids.length === 0) {
      // The new head is unknown entirely; only a resnapshot can serve it.
      stream.resync(sessionId)
      return
    }
    let alive = true

    const heal = async () => {
      let cursor = start.chain.oldestId
      for (let page = 0; page < maxHealPages && alive; page++) {
        try {
          const res = await sessionAPI.entries(sessionId, cursor, pageLimit)
          if (!alive) return
          dispatch({ type: 'backfill', entries: res.entries })
          const oldest = res.entries[0]
          if (oldest && (oldest.parentId ?? '') === '') return // a root is now local
          if (!oldest || !res.cursor) break // server is dry; rebuild via resync
          cursor = oldest.id
        } catch {
          break // network trouble; the resync below rebuilds from scratch
        }
      }
      if (!alive) return
      stream.resync(sessionId)
    }

    void heal()
    return () => {
      alive = false
    }
  }, [stream, sessionId, state.healTick])

  const loadOlder = useCallback(async (): Promise<boolean> => {
    const oldest = stateRef.current.chain.oldestId
    if (oldest === '') return false // nothing held to page from yet
    try {
      const res: { entries: Entry[]; cursor?: string } = await sessionAPI.entries(
        sessionId,
        oldest,
        pageLimit,
      )
      dispatch({ type: 'backfill', entries: res.entries })
      return res.entries.length > 0
    } catch {
      return false // a failed page leaves state untouched; the button stays for a retry
    }
  }, [sessionId])

  return { state, phase, loadOlder, dispatch }
}

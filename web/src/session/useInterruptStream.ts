import { useCallback, useEffect, useRef, useState } from 'react'

import { describeError } from '../api/errors'
import { sessions as sessionAPI } from '../api/endpoints'
import { overlayOpen } from '../ui/overlayStack'

export interface UseInterruptStreamOptions {
  sessionId: string
  busy: boolean // a turn is streaming; Escape only acts while one is
  onToast: (text: string, level?: 'info' | 'error') => void
  // enabled marks the surface the viewer is on: background tile panes and
  // overlays covering the session leave Escape alone
  enabled?: boolean
}

// useInterruptStream binds Escape on a session's viewing surface to
// interrupting its running turn, and hands the same guarded fire to explicit
// stop buttons. Claims below win first: an open overlay layer keeps Escape
// for itself, a prior preventDefault (the composer hiding its @-menu) stands,
// and an unanswered request swallows repeat presses. Returns the guarded
// fire plus whether one request is on the wire.
export function useInterruptStream({
  sessionId,
  busy,
  onToast,
  enabled = true,
}: UseInterruptStreamOptions): { interrupt: () => void; inFlight: boolean } {
  const [inFlight, setInFlight] = useState(false)
  // the key listener binds once; every decision below reads this mirror
  const ref = useRef({ sessionId, busy, onToast })
  useEffect(() => {
    ref.current = { sessionId, busy, onToast }
  })
  // synchronous in-flight flag: repeat presses can land before the state
  // update above commits
  const pendingRef = useRef(false)

  const interrupt = useCallback(() => {
    const cur = ref.current
    if (!cur.busy || pendingRef.current) return
    pendingRef.current = true
    setInFlight(true)
    void sessionAPI
      .interrupt(cur.sessionId)
      .catch((err: unknown) => {
        cur.onToast(describeError(err, 'Interrupt failed.'), 'error')
      })
      .finally(() => {
        pendingRef.current = false
        setInFlight(false)
      })
  }, [])

  useEffect(() => {
    if (!enabled) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || ev.ctrlKey || ev.metaKey || ev.altKey) return
      if (ev.isComposing || ev.defaultPrevented) return // a claim already made wins
      if (overlayOpen()) return // the open layer keeps Escape
      const cur = ref.current
      if (!cur.busy || pendingRef.current) return
      ev.preventDefault() // claims the press: the workspace's Escape stands down
      interrupt()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, interrupt])

  return { interrupt, inFlight }
}

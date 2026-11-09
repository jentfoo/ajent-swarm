import { useEffect, useRef } from 'react'

import { overlayOpen } from '../ui/overlayStack'

// rewindWindowMs is how close two idle Escapes must be to read as the rewind
// gesture, matching ajent's TUI double-Esc window.
const rewindWindowMs = 400

export interface UseRewindGestureOptions {
  // idle gates the gesture to a session at rest, the caller decides whether a
  // running turn, a spinner, a pending dialog or an unreachable stream keeps it
  idle: boolean
  onRewind: () => void
  // enabled marks the surface the viewer is on: background tile panes and
  // other screens leave the keys alone
  enabled?: boolean
}

// useRewindGesture binds ajent's idle rewind gesture on a session's viewing
// surface: two plain Escapes inside the window fire `onRewind`, the picker's
// opener. The first press stays unclaimed, so every single-Esc meaning keeps
// working, only the second press is claimed, and only while nothing else owns
// Escape: an open overlay layer keeps it, a claim another listener already
// made stands, and a not-idle press belongs to the interrupt. Any other key
// ends the armed window, so a stray press never rewinds later.
export function useRewindGesture({
  idle,
  onRewind,
  enabled = true,
}: UseRewindGestureOptions): void {
  // the key listener binds once, every decision below reads this mirror
  const ref = useRef({ idle, onRewind })
  useEffect(() => {
    ref.current = { idle, onRewind }
  })
  // the clock reading of the first eligible Esc, null while unarmed
  const armedRef = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || ev.ctrlKey || ev.metaKey || ev.altKey) {
        armedRef.current = null // any other key ends the window
        return
      }
      if (ev.isComposing || ev.defaultPrevented) {
        armedRef.current = null // the press belonged to another surface
        return
      }
      if (overlayOpen()) {
        armedRef.current = null // the open layer keeps Escape
        return
      }
      const cur = ref.current
      if (!cur.idle) {
        armedRef.current = null // mid-turn Escape interrupts, never rewinds
        return
      }
      const armed = armedRef.current
      if (armed !== null && Date.now() - armed <= rewindWindowMs) {
        armedRef.current = null
        ev.preventDefault() // claims the press: workspace Escape stands down
        cur.onRewind()
        return
      }
      armedRef.current = Date.now() // a lone Esc arms; the next key decides
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      armedRef.current = null // an unbound surface keeps no half pair
    }
  }, [enabled])
}

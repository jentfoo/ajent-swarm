import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

import { scrollableUnder } from './scrollable'

// pullRefreshPx is how far a downward drag past the top must travel for its
// release to count as a refresh, matched with the transcript's pull-to-latest
// threshold so mobile gestures feel alike.
const pullRefreshPx = 64

// usePullToRefresh is the launcher's pull-down gesture: while a touch scroll
// sits at the very top, dragging further down and releasing past the threshold
// calls onRefresh once. A touch that scrolled first stays void for its whole
// life, so only pulls beginning at rest at the top count.
// Overlapping pulls during an in-flight refresh are dropped. Listeners ride
// touch events only, so pointer scrolling never sees them, and no handler
// blocks default behavior, so normal scrolling is intact.
//
// surface is the ref of the element bounding where gestures may start, returns
// true from a qualifying release until every refresh settles.
export function usePullToRefresh(
  surface: RefObject<HTMLDivElement | null>,
  onRefresh: () => Promise<void>,
): boolean {
  const [refreshing, setRefreshing] = useState(false)

  // onRefresh rides a ref so re-renders never rebind the listeners
  const onRefreshRef = useRef(onRefresh)
  useEffect(() => {
    onRefreshRef.current = onRefresh
  })

  useEffect(() => {
    const el = surface.current
    if (!el) return

    let startY: number | null = null // touchstart clientY, null when idle
    let scroller: HTMLElement | null = null
    let furthest = 0 // deepest downward pull of the active gesture
    let scrolled = false // the page moved under the finger; voids the candidate
    // mirrors refreshing synchronously, so a release landing during an
    // in-flight refresh cannot stack behind a state update
    let busy = false

    const run = async () => {
      if (busy) return
      busy = true
      setRefreshing(true)
      try {
        await onRefreshRef.current()
      } catch {
        // screens report their own failures, the gesture only marks progress
      } finally {
        busy = false
        setRefreshing(false)
      }
    }

    const begin = (ev: TouchEvent) => {
      // one fresh finger seeds a candidate, anything else (a second touch
      // landing mid-gesture, a pinch) kills the pending one
      const t = ev.touches.length === 1 ? ev.touches[0] : undefined
      startY = t?.clientY ?? null
      scroller = t && ev.target instanceof Element ? scrollableUnder(ev.target, 'y') : null
      furthest = 0
      scrolled = false
    }
    const move = (ev: TouchEvent) => {
      if (startY === null || scroller === null || ev.touches.length !== 1) return
      // first scrolled move voids the candidate: returning to the top mid-touch
      // never resumes from the original start (mirrored by TranscriptView)
      if (scroller.scrollTop > 0) scrolled = true
      if (scrolled) return
      const dy = ev.touches[0].clientY - startY
      furthest = Math.max(furthest, dy)
    }
    const end = () => {
      const pulled = startY !== null && scroller !== null && !scrolled && furthest >= pullRefreshPx
      startY = null
      scroller = null
      furthest = 0
      scrolled = false
      if (pulled) void run()
    }
    // a canceled touch never became a deliberate release
    const cancel = () => {
      startY = null
      scroller = null
      furthest = 0
      scrolled = false
    }

    el.addEventListener('touchstart', begin, { passive: true })
    el.addEventListener('touchmove', move, { passive: true })
    el.addEventListener('touchend', end, { passive: true })
    el.addEventListener('touchcancel', cancel, { passive: true })
    return () => {
      el.removeEventListener('touchstart', begin)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', cancel)
    }
  }, [surface])

  return refreshing
}

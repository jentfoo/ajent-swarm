import { useEffect, useRef } from 'react'

// usePoll runs fn once on mount and then on a fixed cadence while the tab is
// visible, refreshing immediately when the tab regains focus. Backgrounded
// mobile tabs throttle timers and drop sockets, so hidden ticks are skipped
// instead of queued.
export function usePoll(fn: () => void, intervalMs: number) {
  const ref = useRef(fn)
  useEffect(() => {
    ref.current = fn
  }, [fn])

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null

    const tick = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        ref.current()
      }
    }

    const start = () => {
      if (timer !== null) return
      timer = setInterval(tick, intervalMs)
    }
    const stop = () => {
      if (timer !== null) clearInterval(timer)
      timer = null
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        tick()
        start()
      } else {
        stop()
      }
    }

    tick() // initial load must not wait out the first interval
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [intervalMs])
}

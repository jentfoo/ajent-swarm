import { useEffect, useRef } from 'react'

// usePoll runs fn once on mount and then on a fixed cadence while the tab is
// visible, refreshing immediately when the tab regains focus. Backgrounded
// mobile tabs throttle timers and drop sockets, so hidden ticks are skipped
// unless backgroundMs is set, which keeps a slower cadence alive while hidden
// (what the attention digest needs to raise notifications).
export function usePoll(fn: () => void, intervalMs: number, backgroundMs?: number) {
  const ref = useRef(fn)
  useEffect(() => {
    ref.current = fn
  }, [fn])

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null

    const tick = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        ref.current()
        return
      }
      if (backgroundMs !== undefined) ref.current()
    }

    const start = (every: number) => {
      if (timer !== null) clearInterval(timer)
      timer = setInterval(tick, every)
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        tick()
        start(intervalMs)
      } else {
        // Backgrounded tabs throttle timers; a slower poll keeps running only
        // for callers that asked for it.
        start(backgroundMs ?? intervalMs)
      }
    }

    tick() // initial load must not wait out the first interval
    start(intervalMs)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (timer !== null) clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [intervalMs, backgroundMs])
}

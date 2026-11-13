import { useEffect, useRef, useState } from 'react'

// useRafThrottled commits at most one value per animation frame, so a stream
// of high-frequency updates (streaming deltas) re-renders a consumer at most
// once per paint instead of once per event.
export function useRafThrottled<T>(value: T): T {
  const [committed, setCommitted] = useState(value)
  const latest = useRef(value)
  const frame = useRef<number | null>(null)

  useEffect(() => {
    // runs before the scheduler effect below on the same render pass
    latest.current = value
  }, [value])

  useEffect(() => {
    if (frame.current !== null) return // one commit already scheduled this paint
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      setCommitted(latest.current)
    })
    return () => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current)
        frame.current = null
      }
    }
  }, [value])

  return committed
}

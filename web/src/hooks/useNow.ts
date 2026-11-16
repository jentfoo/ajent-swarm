import { useEffect, useState } from 'react'

// useNow ticks a Date.now snapshot every intervalMs, so relative labels stay
// honest even when nothing else re-renders. Labels need no per-second
// freshness, so callers pass a coarse interval.
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

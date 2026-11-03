import { useEffect, useState } from 'react'

import type { NoticeView } from '../state/eventApplier'

// noticeTtlMs bounds how long a streamed notice stays visible: upstream's
// keyed lines replace each other but nothing ever clears them, so without an
// expiry "Sub-agent sub-6 completed" parks under the composer forever.
const noticeTtlMs = 8_000

// Notices renders a session's transient notice lines (sub-agent completions,
// upstream warnings): lines expire noticeTtlMs after arrival and the newest
// three show at once. Hosts mount it above the dialog dock.
export function Notices({ notices }: { notices: NoticeView[] }) {
  const [now, setNow] = useState(() => Date.now())
  const fresh = notices.filter((n) => now - n.at < noticeTtlMs)
  const hasFresh = fresh.length > 0
  // tick only while a line is fresh: stale lines stay in state forever, so a
  // length gate ticks forever. New arrivals flip hasFresh on their own render
  useEffect(() => {
    if (!hasFresh) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [hasFresh])
  if (!hasFresh) return null
  return (
    <div aria-label="Notices">
      {fresh.slice(-3).map((n, i) => (
        <div key={`${i}-${n.key}`} className={`block-notice ${n.level}`}>
          {n.text}
        </div>
      ))}
    </div>
  )
}

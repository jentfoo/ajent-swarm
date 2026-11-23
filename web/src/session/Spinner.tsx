import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import { useMediaQuery } from '../hooks/useMediaQuery'

import type { CtlState } from '../api/types'
import { sessionBusy } from '../state/eventApplier'
import type { LiveTurn } from '../state/eventApplier'

// The TUI's working glyph: the same braille frames at the same cadence, so
// both surfaces read as one product.
const frames = ['⠦', '⠧', '⠇', '⠏', '⠋', '⠙', '⠹', '⠸', '⠼', '⠴']
const frameMs = 90
const reducedMotionQuery = '(prefers-reduced-motion: reduce)'

type SpinState = 'idle' | 'wait' | 'stream' | 'tool'

// spinnerState maps the session's facts onto the glyph's color state. The
// reconciled snapshot owns activity: not running or spinning is idle no matter
// what a stale live buffer paints, and while working the buffer only refines
// the color (tool first, then streamed output, then wait).
export function spinnerState(snap: CtlState, live?: LiveTurn | null): SpinState {
  if (!sessionBusy(snap)) return 'idle'
  const toolRunning = (live?.tools ?? []).some((t) => t.result === undefined && !t.closed)
  if (toolRunning) return 'tool'
  if (live && (live.thinking !== '' || live.text !== '')) return 'stream'
  return 'wait'
}

// Spinner is the working glyph: first element of the status line on both
// surfaces, animating only while work is in flight and resting static dim
// when idle, exactly like ajent's own status bar. Reduced motion holds the
// first frame and stops the interval, live with the media preference.
// The changing glyph is aria-hidden decoration; a stable sr-only state word
// is the one accessible name, so no frame ever re-announces.
export function Spinner({ state }: { state: SpinState }): ReactElement {
  const reduced = useMediaQuery(reducedMotionQuery)
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (state === 'idle' || reduced) return
    const timer = setInterval(() => setFrame((f) => f + 1), frameMs)
    return () => clearInterval(timer)
  }, [state, reduced])

  return (
    <span className={`spinner ${state}`}>
      <span aria-hidden="true">
        {state === 'idle' || reduced ? frames[0] : frames[frame % frames.length]}
      </span>
      <span className="sr-only">{state === 'idle' ? 'idle' : 'working'}</span>
    </span>
  )
}

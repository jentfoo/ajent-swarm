import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import type { CtlState } from '../api/types'
import type { LiveTurn } from '../state/eventApplier'

// The TUI's working glyph: the same braille frames at the same cadence, so
// both surfaces read as one product.
const frames = ['⠦', '⠧', '⠇', '⠏', '⠋', '⠙', '⠹', '⠸', '⠼', '⠴']
const frameMs = 90

export type SpinState = 'idle' | 'wait' | 'stream' | 'tool'

// spinnerState maps the session's facts onto the glyph's color state: a
// running tool wins, then model output arriving, then a turn in flight with
// nothing streaming back yet, and idle at rest.
export function spinnerState(snap: CtlState, live?: LiveTurn | null): SpinState {
  const toolRunning = (live?.tools ?? []).some((t) => t.result === undefined && !t.closed)
  if (toolRunning) return 'tool'
  if (live && (live.thinking !== '' || live.text !== '')) return 'stream'
  if (snap.running || snap.spinning) return 'wait'
  return 'idle'
}

// Spinner is the working glyph: first element of the status line on both
// surfaces, animating only while work is in flight and resting static dim
// when idle, exactly like ajent's own status bar.
export function Spinner({ state }: { state: SpinState }): ReactElement {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (state === 'idle') return
    const timer = setInterval(() => setFrame((f) => f + 1), frameMs)
    return () => clearInterval(timer)
  }, [state])

  return (
    <span
      className={`spinner ${state}`}
      role="img"
      aria-label={state === 'idle' ? 'idle' : 'working'}
    >
      {state === 'idle' ? frames[0] : frames[frame % frames.length]}
    </span>
  )
}

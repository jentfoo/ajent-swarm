import { useEffect, useRef } from 'react'

import { overlayOpen } from '../ui/overlayStack'
import { caretInInput } from './dialogKeys'

export interface UseQueuedRecallOptions {
  // onRecall pops the newest queued prompt into the composer, the same guarded
  // call the chip's edit button fires.
  onRecall: () => void
  // canRecall gates claiming the press: with nothing queued, or while a dialog
  // holds input, Alt+ArrowUp stays free for other bindings.
  canRecall: boolean
  // enabled marks the surface the viewer is on; background tile panes stand down.
  enabled?: boolean
}

// useQueuedRecall binds Alt+ArrowUp on a session's viewing surface to
// recalling the newest queued prompt into the composer, ajent's editor
// gesture. The press answers only from an editable target: recall fires while
// composing, which leaves tile mode's Alt+Arrows pane resize untouched
// everywhere else. An open overlay layer keeps every key, a prior
// preventDefault stands, and with nothing queued the press stays unclaimed.
// Touch has no modifier keys, so it never binds there: the chip's edit button
// remains the path.
export function useQueuedRecall({
  onRecall,
  canRecall,
  enabled = true,
}: UseQueuedRecallOptions): void {
  // the listener binds once, reading a mirror of the latest options
  const ref = useRef({ onRecall, canRecall })
  useEffect(() => {
    ref.current = { onRecall, canRecall }
  })

  useEffect(() => {
    if (!enabled) return
    // touch keyboards have no Alt; read per mount so tests can stub the device
    if (window.matchMedia('(pointer: coarse)').matches) return

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'ArrowUp' || !ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return
      if (ev.isComposing || ev.defaultPrevented) return // a claim already made wins
      if (!caretInInput(ev.target)) return // outside the editor, tile resize keeps Alt+Arrows
      if (overlayOpen()) return // the open layer keeps every key
      const cur = ref.current
      if (!cur.canRecall) return
      ev.preventDefault() // claims the press: workspace bindings stand down
      cur.onRecall()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}

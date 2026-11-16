import { useCallback, useEffect, useRef, useState } from 'react'

import { writeClipboard } from './writeClipboard'

// how long the copied/failed label holds before resolving back to idle
const copyStateTtlMs = 2_000

export type CopyState = 'idle' | 'copied' | 'failed'

interface CopyText {
  copy: (text: string) => void // writes the text and restarts the label window
  state: CopyState // what the caller's button label shows
}

// useCopyText writes raw text through writeClipboard (async Clipboard API with
// an execCommand fallback for Firefox rejections and plain-HTTP origins) and
// exposes one transient label state: copied after a successful write, failed
// when every path fails, resolving back to idle on a timer that unmount
// clears. Only the newest copy settles, so a slow earlier write cannot
// overwrite a later result.
export function useCopyText(): CopyText {
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)
  const latestWrite = useRef(0)

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clearTimer()
    }
  }, [clearTimer])

  const copy = useCallback(
    (text: string) => {
      clearTimer()
      const id = ++latestWrite.current
      const settle = (next: CopyState) => {
        // a newer copy or an unmount already retired this write
        if (!alive.current || id !== latestWrite.current) return
        setState(next)
        timer.current = setTimeout(() => {
          timer.current = null
          if (alive.current) setState('idle')
        }, copyStateTtlMs)
      }
      void writeClipboard(text).then(
        () => settle('copied'),
        () => settle('failed'),
      )
    },
    [clearTimer],
  )

  return { copy, state }
}

import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

// longPressMs is the hold time before the rename affordance fires.
const longPressMs = 500

interface LongPressHandlers {
  pressed: boolean // true while a touch or press is held, for row styling
  onPointerDown: (ev: ReactPointerEvent) => void
  onPointerUp: () => void
  onPointerLeave: () => void
  onPointerCancel: () => void
}

// useLongPress fires after a held touch; any early release or pointer leaving
// cancels it, so scrolling the sheet never triggers a rename.
export function useLongPress(onLongPress: () => void): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pressed, setPressed] = useState(false)

  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    setPressed(false)
  }

  useEffect(() => cancel, [])

  return {
    pressed,
    onPointerDown: (ev) => {
      if (!ev.isPrimary) return
      setPressed(true)
      timer.current = setTimeout(() => {
        timer.current = null
        setPressed(false)
        onLongPress()
      }, longPressMs)
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
  }
}

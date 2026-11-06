import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

// longPressMs is the hold time before the rename affordance fires.
const longPressMs = 500

// clickBlockMs bounds how long a fired hold keeps swallowing taps after its
// release. Every real gesture starts with a pointerdown, which disarms first.
const clickBlockMs = 1_000

interface LongPressHandlers {
  pressed: boolean // true while a touch or press is held, for row styling
  onPointerDown: (ev: ReactPointerEvent) => void
  onPointerUp: () => void
  onPointerLeave: () => void
  onPointerCancel: () => void
}

// useLongPress fires after a held touch; any early release or pointer leaving
// cancels it, so scrolling the sheet never triggers a rename. A fired hold
// also swallows the tap its release synthesizes, wherever that click lands,
// so holding to rename does not read as opening the row underneath.
export function useLongPress(onLongPress: () => void): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pressed, setPressed] = useState(false)
  // fired marks a hold that ran past the threshold this gesture. Its release
  // must not leak through as a tap.
  const fired = useRef(false)
  // stopClickBlock undoes the armed release-tap blocker, null when disarmed.
  const stopClickBlock = useRef<(() => void) | null>(null)

  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    setPressed(false)
  }

  useEffect(() => cancel, [])

  // a blocker never outlives its hook
  useEffect(
    () => () => {
      stopClickBlock.current?.()
    },
    [],
  )

  // armClickBlock eats the one tap that follows a fired hold's release. It
  // sits on window capture because opening the rename editor mid-hold can
  // retarget that click onto an ancestor or the new overlay. Any fresh
  // pointerdown (or the expiry) disarms it first, so only this gesture's leak
  // is swallowed.
  const armClickBlock = () => {
    stopClickBlock.current?.()
    let stopped = false

    function stop() {
      if (stopped) return
      stopped = true
      window.removeEventListener('click', swallow, true)
      window.removeEventListener('pointerdown', stop, true)
      clearTimeout(expiry)
      stopClickBlock.current = null
    }
    function swallow(ev: MouseEvent) {
      ev.preventDefault()
      ev.stopPropagation() // capture halts the path before any React handler
      stop()
    }

    window.addEventListener('click', swallow, true)
    window.addEventListener('pointerdown', stop, true)
    const expiry = setTimeout(stop, clickBlockMs)
    stopClickBlock.current = stop
  }

  // release ends the gesture; after a fired hold it also arms the blocker,
  // since mice have no pointer capture and their release can land outside the
  // row entirely, retargeting the trailing click onto a common ancestor.
  const release = () => {
    if (fired.current) armClickBlock()
    cancel()
  }

  return {
    pressed,
    onPointerDown: (ev) => {
      if (!ev.isPrimary) return
      stopClickBlock.current?.() // a new gesture never inherits the last blocker
      fired.current = false
      setPressed(true)
      timer.current = setTimeout(() => {
        timer.current = null
        setPressed(false)
        fired.current = true
        onLongPress()
      }, longPressMs)
    },
    onPointerUp: release,
    onPointerLeave: release,
    onPointerCancel: cancel,
  }
}

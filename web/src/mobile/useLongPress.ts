import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

// longPressMs is the hold time before the row affordance fires.
const longPressMs = 500

// moveSlopPx is how far a held pointer may wander in either axis before the
// hold reads as a drag or scroll, matched with BottomSheet's tap slop.
const moveSlopPx = 8

// clickBlockMs bounds how long a fired hold keeps swallowing taps after its
// release. Every real gesture starts with a pointerdown, which disarms first.
const clickBlockMs = 1_000

// LongPressDrag extends the gesture past its hold: movement converts the
// fired hold into a row drag whose target is the [data-session-id] row under
// the pointer.
export interface LongPressDrag {
  // target validity under the pointer; invalid rows never highlight nor drop
  canDrop: (sessionId: string) => boolean
  // the hold converted into a drag, its hold-opened menu should close
  onDragStart?: () => void
  // the row under the pointer changed, null over invalid ground
  onDragTarget: (sessionId: string | null) => void
  // the drag released over a valid row
  onDrop: (sessionId: string) => void
  // the drag ended without a drop (released elsewhere, cancelled)
  onDragEnd: () => void
}

interface LongPressHandlers {
  pressed: boolean // true while a touch or press is held, for row styling
  dragging: boolean // true once a fired hold converted into a drag
  onPointerDown: (ev: ReactPointerEvent) => void
  onPointerMove: (ev: ReactPointerEvent) => void
  onPointerUp: () => void
  onPointerLeave: () => void
  onPointerCancel: () => void
}

// useLongPress fires after a held touch, any early release or pointer leaving
// cancels it, so scrolling the rows never triggers the hold. A hold whose
// pointer drags past moveSlopPx first cancels the same way and its release
// tap stays ordinary. With a drag config the machine extends past the hold:
// the fired hold captures the pointer, further movement past the slop lifts
// the row into a drag, and a release over a droppable row reports the drop
// through the config. A fired hold or drag also swallows the tap its release
// synthesizes, wherever that click lands, so holding to open the menu or
// dragging onto a row never reads as opening the row beneath.
export function useLongPress(
  onLongPress: (x: number, y: number) => void,
  drag?: LongPressDrag,
): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pressed, setPressed] = useState(false)
  const [dragging, setDragging] = useState(false)
  // startX/startY anchor the slop check and name the hold point; they only
  // matter while the gesture runs. lastX/lastY follow the pointer so a bare
  // release (no event of its own) still resolves its target.
  const startX = useRef(0)
  const startY = useRef(0)
  const lastX = useRef(0)
  const lastY = useRef(0)
  // fired marks a hold that ran past the threshold this gesture. Its release
  // must not leak through as a tap, and only a fired hold may drag.
  const fired = useRef(false)
  // the press's element and pointer, captured at down so the drag can keep
  // every later move once the hold takes the pointer
  const pressEl = useRef<HTMLElement | null>(null)
  const pointerId = useRef(-1)
  // draggingRef mirrors `dragging` for the event handlers, which need the
  // gesture's state synchronously, not a render later
  const draggingRef = useRef(false)
  // stopClickBlock undoes the armed release-tap blocker, null when disarmed.
  const stopClickBlock = useRef<(() => void) | null>(null)
  // detachScroll removes the gesture's touchmove blocker, a no-op when none.
  const detachScroll = useRef(() => {})
  // latest drag config, so the handlers never close over a stale one
  const dragRef = useRef(drag)
  useEffect(() => {
    dragRef.current = drag
  })

  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    setPressed(false)
  }

  // no timer, scroll blocker or click blocker outlives its hook
  useEffect(
    () => () => {
      cancel()
      detachScroll.current()
      stopClickBlock.current?.()
    },
    [],
  )

  // armClickBlock eats the one tap that follows a fired hold's release. It
  // sits on window capture because opening the menu mid-hold can retarget
  // that click onto an ancestor or the new overlay. Any fresh pointerdown
  // (or the expiry) disarms it first, so only this gesture's leak is
  // swallowed.
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

  // armScrollBlock keeps the browser from scrolling the list away under a
  // fired hold: without it the scroll steals the pointer (pointercancel) the
  // moment the held finger moves, and no drag could ever begin.
  const armScrollBlock = () => {
    const block = (ev: TouchEvent) => {
      if (fired.current) ev.preventDefault()
    }
    window.addEventListener('touchmove', block, { passive: false, capture: true })
    detachScroll.current = () => window.removeEventListener('touchmove', block, true)
  }

  // targetUnder names the droppable row at a point, null over anything else.
  const targetUnder = (x: number, y: number): string | null => {
    const config = dragRef.current
    if (config === undefined) return null
    const hit = document.elementFromPoint(x, y)
    const row = hit?.closest<HTMLElement>('[data-session-id]')
    const id = row?.dataset.sessionId
    return id !== undefined && config.canDrop(id) ? id : null
  }

  const reportTarget = (id: string | null) => {
    dragRef.current?.onDragTarget(id)
  }

  const beginDrag = () => {
    draggingRef.current = true
    setDragging(true)
    dragRef.current?.onDragStart?.()
  }

  // finish clears every gesture track; a live drag reports its end unless a
  // drop is landing in its place
  const finish = (dropping: boolean) => {
    detachScroll.current()
    detachScroll.current = () => {}
    if (draggingRef.current) {
      draggingRef.current = false
      setDragging(false)
      if (!dropping) dragRef.current?.onDragEnd()
    }
    fired.current = false
    pressEl.current = null // the capture dies with the pointer's up or cancel
  }

  // release ends the gesture, after a fired hold it also arms the blocker,
  // since mice have no pointer capture and their release can land outside the
  // row entirely, retargeting the trailing click onto a common ancestor.
  const release = () => {
    if (fired.current) armClickBlock()
    finish(false)
    cancel()
  }

  return {
    pressed,
    dragging,
    onPointerDown: (ev) => {
      if (!ev.isPrimary) return
      stopClickBlock.current?.() // a new gesture never inherits the last blocker
      if (timer.current !== null) clearTimeout(timer.current) // nor the last timer
      fired.current = false
      startX.current = ev.clientX
      startY.current = ev.clientY
      lastX.current = ev.clientX
      lastY.current = ev.clientY
      pressEl.current = ev.currentTarget as HTMLElement
      pointerId.current = ev.pointerId
      setPressed(true)
      armScrollBlock()
      timer.current = setTimeout(() => {
        timer.current = null
        setPressed(false)
        fired.current = true
        // capture keeps every later move on this row, even off it, so the
        // drag keeps reporting while the finger crosses its neighbours
        try {
          pressEl.current?.setPointerCapture(pointerId.current)
        } catch {
          // a refused capture (test DOMs, lost pointers) still tracks the
          // moves that arrive
        }
        onLongPress(startX.current, startY.current)
      }, longPressMs)
    },
    // movement splits three ways: a pending hold past the slop is a scroll
    // and cancels, a fired hold past the slop lifts into a drag, and a live
    // drag just tracks its target
    onPointerMove: (ev) => {
      if (!ev.isPrimary) return
      lastX.current = ev.clientX
      lastY.current = ev.clientY
      const dx = Math.abs(ev.clientX - startX.current)
      const dy = Math.abs(ev.clientY - startY.current)
      const moved = dx > moveSlopPx || dy > moveSlopPx
      if (timer.current !== null) {
        if (moved) cancel()
        return
      }
      if (!fired.current) return
      if (!draggingRef.current) {
        if (!moved || dragRef.current === undefined) return
        beginDrag()
      }
      reportTarget(targetUnder(ev.clientX, ev.clientY))
    },
    onPointerUp: () => {
      // the target resolves at the release point, the last move can lag it
      const target = draggingRef.current ? targetUnder(lastX.current, lastY.current) : null
      if (fired.current) armClickBlock()
      finish(target !== null)
      cancel()
      if (target !== null) dragRef.current?.onDrop(target)
    },
    onPointerLeave: release,
    onPointerCancel: () => {
      finish(false)
      cancel()
    },
  }
}

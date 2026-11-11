import { useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'

import { useFocusTrap } from '../ui/useFocusTrap'
import { useOverlayBack } from '../ui/useOverlayBack'
import { useOverlayDismiss } from '../ui/overlayStack'

// dismissThreshold is how far the sheet must be dragged down before release
// closes it, below that it springs back open.
const dismissThreshold = 96

// tapSlop is how far a handle press may wander before it stops reading as a
// tap and goes back to being a drag.
const tapSlop = 8

// BottomSheet is a full-width panel docked to the bottom with a drag handle:
// drag it past the threshold, tap the handle, tap the backdrop or press
// Escape to dismiss. Children render inside the scrollable body, so tall
// content never fights the gesture. The backdrop reads --keyboard-inset,
// which MobileShell publishes at :root: ancestor padding cannot move a
// position:fixed panel, so the backdrop shrinks from the bottom instead.
//
// Mobile overlays follow one convention: draggable sheets for lightweight
// pickers over the session (rewind), pushed full-screen *Screen
// panels (tools, settings), and desktop-style centered modals for tiny forms
// shared with desktop.
//
// The sheet rides the shared layer contract with ModalShell and the pushed
// screens: useOverlayDismiss owns Escape and the focus restore, useFocusTrap
// owns Tab containment and focus recapture.
export function BottomSheet({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean
  onClose: () => void
  label: string
  children: ReactElement
}): ReactElement | null {
  if (!open) return null
  return (
    <SheetLayer onClose={onClose} label={label}>
      {children}
    </SheetLayer>
  )
}

// SheetLayer is the open sheet, mounting is what opens it, so the drag offset,
// focus and the history entry live exactly as long as the sheet does and a
// reopen can never inherit any of them.
function SheetLayer({
  onClose,
  label,
  children,
}: {
  onClose: () => void
  label: string
  children: ReactElement
}): ReactElement {
  const [dragY, setDragY] = useState(0)
  const sheetRef = useRef<HTMLElement>(null)
  // one pointer owns a drag, later fingers can neither steer nor release it
  const start = useRef<{ pointerId: number; x: number; y: number } | null>(null)

  useOverlayDismiss(sheetRef, onClose)
  useFocusTrap(sheetRef)
  useOverlayBack(onClose)

  const onPointerDown = (ev: ReactPointerEvent<HTMLDivElement>) => {
    // a drag in flight never adopts the newcomer, that would hand it over
    if (start.current !== null) return
    start.current = { pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY }
    ev.currentTarget.setPointerCapture(ev.pointerId)
  }
  const onPointerMove = (ev: ReactPointerEvent<HTMLDivElement>) => {
    const began = start.current
    // gestures not started on the handle scroll, other pointers are noise
    if (began === null || began.pointerId !== ev.pointerId) return
    setDragY(Math.max(0, ev.clientY - began.y))
  }

  // the release decision reads the last committed offset, updaters stay pure,
  // so StrictMode's double render cannot close the sheet twice. A foreign
  // pointer lifting is not a release and leaves the drag running
  const onPointerUp = (ev: ReactPointerEvent<HTMLDivElement>) => {
    const began = start.current
    if (began === null || began.pointerId !== ev.pointerId) return
    start.current = null
    const wandered =
      Math.abs(ev.clientX - began.x) < tapSlop && Math.abs(ev.clientY - began.y) < tapSlop
    if (dragY >= dismissThreshold || wandered) onClose()
    setDragY(0)
  }

  // a pointer the system took back (an incoming call, a notification shade)
  // never reads as a release: the sheet springs back open. Only the owning
  // pointer cancels, a second finger losing to a gesture keeps its drag alive
  const onPointerCancel = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (start.current?.pointerId !== ev.pointerId) return
    start.current = null
    setDragY(0)
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`bottom-sheet ${dragY > 0 ? 'dragging' : ''}`}
        style={dragY > 0 ? { transform: `translateY(${dragY}px)` } : undefined}
        onClick={(ev) => ev.stopPropagation()}
      >
        <div
          className="sheet-handle"
          role="button"
          tabIndex={0}
          aria-label={`Dismiss ${label}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onKeyDown={(ev) => {
            if (ev.key !== 'Enter' && ev.key !== ' ') return
            ev.preventDefault()
            onClose()
          }}
        >
          <span className="sheet-grip" />
        </div>
        {children}
      </section>
    </div>
  )
}

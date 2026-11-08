import { useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'

import { useKeyboardInset, keyboardInsetStyle } from '../hooks/useKeyboardInset'
import { useOverlayDismiss } from '../ui/overlayStack'
import { useOverlayBack } from '../ui/useOverlayBack'

// dismissThreshold is how far the sheet must be dragged down before release
// closes it; below that it springs back open.
const dismissThreshold = 96

// tapSlop is how far a handle press may wander before it stops reading as a
// tap and goes back to being a drag.
const tapSlop = 8

// BottomSheet is a full-width panel docked to the bottom with a drag handle:
// drag it past the threshold, tap the handle, tap the backdrop or press
// Escape to dismiss. Children render inside the scrollable body, so tall
// content never fights the gesture. The sheet tracks the keyboard inset
// itself: ancestor padding cannot move a position:fixed panel, so the backdrop
// shrinks from the bottom instead.
//
// Mobile overlays follow one convention: draggable sheets for lightweight
// pickers over the session (switcher, rewind), pushed full-screen *Screen
// panels (tools, settings), and desktop-style centered modals for tiny forms
// shared with desktop.
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

// SheetLayer is the open sheet; mounting is what opens it, so the drag offset,
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
  const keyboardInset = useKeyboardInset()
  const [dragY, setDragY] = useState(0)
  const sheetRef = useRef<HTMLElement>(null)
  const start = useRef<{ x: number; y: number } | null>(null)

  useOverlayDismiss(sheetRef, onClose)
  useOverlayBack(onClose)

  const onPointerDown = (ev: ReactPointerEvent<HTMLDivElement>) => {
    start.current = { x: ev.clientX, y: ev.clientY }
    ev.currentTarget.setPointerCapture(ev.pointerId)
  }
  const onPointerMove = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (start.current === null) return // gestures not started on the handle scroll
    setDragY(Math.max(0, ev.clientY - start.current.y))
  }

  // the release decision reads the last committed offset; updaters stay pure,
  // so StrictMode's double render cannot close the sheet twice
  const onPointerUp = (ev: ReactPointerEvent<HTMLDivElement>) => {
    const began = start.current
    start.current = null
    if (began === null) return
    const wandered =
      Math.abs(ev.clientX - began.x) < tapSlop && Math.abs(ev.clientY - began.y) < tapSlop
    if (dragY >= dismissThreshold || wandered) onClose()
    setDragY(0)
  }

  // a pointer the system took back (an incoming call, a notification shade)
  // never reads as a release: the sheet springs back open
  const onPointerCancel = () => {
    start.current = null
    setDragY(0)
  }

  return (
    <div className="sheet-backdrop" style={keyboardInsetStyle(keyboardInset)} onClick={onClose}>
      <section
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
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

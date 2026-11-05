import { useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'

import { useKeyboardInset, keyboardInsetStyle } from '../hooks/useKeyboardInset'

// dismissThreshold is how far the sheet must be dragged down before release
// closes it; below that it springs back open.
const dismissThreshold = 96

// BottomSheet is a full-width panel docked to the bottom with a drag handle:
// drag it past the threshold (or tap the backdrop) to dismiss. Children render
// inside the scrollable body, so tall content never fights the gesture. The
// sheet tracks the keyboard inset itself: ancestor padding cannot move a
// position:fixed panel, so the backdrop shrinks from the bottom instead.
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
}) {
  const keyboardInset = useKeyboardInset()
  const [dragY, setDragY] = useState(0)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    // a closed sheet forgets its drag offset, whatever path dismissed it
    if (!open) setDragY(0)
  }
  const startY = useRef<number | null>(null)

  if (!open) return null

  const onPointerDown = (ev: ReactPointerEvent<HTMLDivElement>) => {
    startY.current = ev.clientY
    ev.currentTarget.setPointerCapture(ev.pointerId)
  }
  const onPointerMove = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (startY.current === null) return // gestures not started on the handle scroll
    setDragY(Math.max(0, ev.clientY - startY.current))
  }

  // the release decision reads the last committed offset; updaters stay pure,
  // so StrictMode's double render cannot close the sheet twice
  const endDrag = () => {
    startY.current = null
    if (dragY >= dismissThreshold) onClose()
    setDragY(0)
  }

  return (
    <div className="sheet-backdrop" style={keyboardInsetStyle(keyboardInset)} onClick={onClose}>
      <section
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
          aria-label={`Dismiss ${label}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <span className="sheet-grip" />
        </div>
        {children}
      </section>
    </div>
  )
}

import { useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'

// dismissThreshold is how far the sheet must be dragged down before release
// closes it; below that it springs back open.
const dismissThreshold = 96

// BottomSheet is a full-width panel docked to the bottom with a drag handle:
// drag it past the threshold (or tap the backdrop) to dismiss. Children render
// inside the scrollable body, so tall content never fights the gesture.
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
  const [dragY, setDragY] = useState(0)
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

  const endDrag = () => {
    startY.current = null
    setDragY((y) => {
      if (y >= dismissThreshold) onClose()
      return 0
    })
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
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

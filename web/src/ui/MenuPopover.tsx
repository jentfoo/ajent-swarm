import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HTMLAttributes, RefObject } from 'react'
import { createPortal } from 'react-dom'

// Space between the trigger's box and the menu.
const anchorGap = 4
// Viewport margin a clamped menu always keeps.
const edgeMargin = 8

interface Placement {
  left: number
  top: number
}

interface Box {
  top: number
  bottom: number
  left: number
  right: number
}

// placeMenu computes fixed coordinates for one popover against a trigger box:
// below when the space there fits, flipped above when only that side does,
// then clamped horizontally into the viewport. A menu fitting neither side
// pins to whichever edge leaves more room.
export function placeMenu(
  anchor: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  align: 'left' | 'right',
): Placement {
  const preferred = align === 'right' ? anchor.right - size.width : anchor.left
  let left = Math.max(preferred, edgeMargin)
  const maxLeft = viewport.width - edgeMargin - size.width
  if (maxLeft > edgeMargin) left = Math.min(left, maxLeft)

  const belowSpace = viewport.height - anchor.bottom - anchorGap
  const aboveSpace = anchor.top - anchorGap
  let top: number
  if (size.height <= belowSpace) {
    top = anchor.bottom + anchorGap
  } else if (size.height <= aboveSpace) {
    top = anchor.top - anchorGap - size.height
  } else if (belowSpace >= aboveSpace) {
    // neither side fits: pin against the roomier edge, inside the viewport
    top = Math.max(
      edgeMargin,
      Math.min(anchor.bottom + anchorGap, viewport.height - edgeMargin - size.height),
    )
  } else {
    top = Math.max(edgeMargin, anchor.top - anchorGap - size.height)
  }
  return { left, top }
}

type MenuPopoverProps = {
  // trigger element the menu anchors to
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  align?: 'left' | 'right'
} & Omit<HTMLAttributes<HTMLDivElement>, 'onClose'>

// Open popover layers, mirroring ModalShell's open shells: key bindings that
// act on page content read this and leave Escape to the open menu.
const openPopovers: HTMLElement[] = []

// popoverOpen reports whether any MenuPopover layer is currently showing.
export function popoverOpen(): boolean {
  return openPopovers.length > 0
}

// MenuPopover portals children into document.body as a fixed layer anchored to
// the trigger in `anchorRef`, so no ancestor's overflow clipping can cut it
// off. It flips above or clamps to stay in the viewport, repositions on scroll
// and resize while open, and closes on Escape or an outside pointerdown.
// Children keep their own menu markup; only placement lives here.
export function MenuPopover({
  anchorRef,
  onClose,
  align = 'left',
  children,
  ...rest
}: MenuPopoverProps) {
  const [placement, setPlacement] = useState<Placement | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const measure = useCallback(() => {
    const anchor = anchorRef.current
    const menu = menuRef.current
    if (!anchor || !menu) return
    const trigger = anchor.getBoundingClientRect()
    const box = menu.getBoundingClientRect()
    setPlacement((prev) => {
      const next = placeMenu(
        trigger,
        { width: box.width, height: box.height },
        { width: window.innerWidth, height: window.innerHeight },
        align,
      )
      // identical coordinates skip the render a scroll tick would cause
      return prev?.left === next.left && prev?.top === next.top ? prev : next
    })
  }, [anchorRef, align])

  useLayoutEffect(() => {
    measure()
  }, [measure])

  useEffect(() => {
    window.addEventListener('resize', measure)
    // capture: ancestor scroll containers move the anchor without a window scroll
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [measure])

  useEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    // content growth re-measures (late fonts, images)
    const observer = new ResizeObserver(measure)
    observer.observe(menu)
    return () => observer.disconnect()
  }, [measure])

  // latest onClose, so the document listeners below never resubscribe
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  useEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    openPopovers.push(menu)
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') closeRef.current()
    }
    const onPointerDown = (ev: PointerEvent) => {
      const target = ev.target as Node
      // the trigger toggles itself; inside the menu is this component's ground
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      closeRef.current()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      const at = openPopovers.indexOf(menu)
      if (at >= 0) openPopovers.splice(at, 1)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [anchorRef])

  // hidden until the first measure, so an unplaced layer never flashes at (0,0)
  return createPortal(
    <div
      ref={menuRef}
      {...rest}
      style={{
        ...rest.style,
        position: 'fixed',
        visibility: placement ? undefined : 'hidden',
        left: placement?.left,
        top: placement?.top,
      }}
    >
      {children}
    </div>,
    document.body,
  )
}

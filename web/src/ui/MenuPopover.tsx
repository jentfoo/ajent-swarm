import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { HTMLAttributes, RefObject } from 'react'
import { createPortal } from 'react-dom'

import { overlayEnter, overlayLeave, overlayTopmost } from './overlayStack'

// Space between the trigger's box and the menu.
const anchorGap = 4
// Viewport margin a clamped menu always keeps.
const edgeMargin = 8

// One shared answer to "was the last input a key press": a menu opened with
// Enter may move focus into its items, one opened by a tap never steals the
// pointer. Capture listeners track it, so every press counts wherever it
// lands, claimed or not.
let lastInputWasKeyboard = false
window.addEventListener(
  'keydown',
  () => {
    lastInputWasKeyboard = true
  },
  true,
)
window.addEventListener(
  'pointerdown',
  () => {
    lastInputWasKeyboard = false
  },
  true,
)

interface Placement {
  left: number
  top: number
  minWidth?: number
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
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  align?: 'left' | 'right'
  // stretch the layer to at least the trigger's width
  matchWidth?: boolean
  // leave focus wherever closing left it, for blur-closed layers
  restoreFocus?: boolean
} & Omit<HTMLAttributes<HTMLDivElement>, 'onClose'>

// enabledItems lists a menu layer's role=menuitem elements in DOM order,
// disabled entries excluded; headings and filter rows never carry the role.
function enabledItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true',
  )
}

// MenuPopover portals children into document.body as a fixed layer anchored to
// the trigger in `anchorRef`, so no ancestor's overflow clipping can cut it
// off. It flips above or clamps to stay in the viewport, follows the trigger
// on scroll, resize and any layout shift while open, registers with
// ui/overlayStack for its lifetime, and
// closes on a plain Escape or an outside pointerdown: only the topmost of
// stacked popovers answers Escape, presses another listener already claimed
// are left alone. Closing returns focus to the element focused at open.
// Layers carrying role="menu" also drive their items: keyboard opens move
// focus to the current or first enabled item (pointer opens never steal),
// arrows and Home/End walk among enabled items, and Tab closes so focus
// cannot strand behind the visible menu. Children keep their own menu markup,
// only placement and these keys live here.
export function MenuPopover({
  anchorRef,
  onClose,
  align = 'left',
  matchWidth = false,
  restoreFocus = true,
  role,
  children,
  ...rest
}: MenuPopoverProps) {
  const [placement, setPlacement] = useState<Placement | null>(null)
  // captured once at first render on purpose: the trigger holds focus while
  // opening, and this is the element closing hands it back to. restoreFocus
  // false captures nothing, so a blur-closed layer never steals the caret.
  const [restoreTarget] = useState(() =>
    restoreFocus ? (document.activeElement as HTMLElement | null) : null,
  )
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
      const minWidth = matchWidth ? trigger.width : undefined
      // identical coordinates skip the render a scroll tick would cause
      return prev?.left === next.left && prev?.top === next.top && prev.minWidth === minWidth
        ? prev
        : { ...next, minWidth }
    })
  }, [anchorRef, align, matchWidth])

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
    const anchor = anchorRef.current
    if (!anchor) return
    // pane drags and layout shifts move the anchor with no scroll or resize
    // event at all: sample its box every frame while open
    let last = anchor.getBoundingClientRect()
    const tick = () => {
      const box = anchor.getBoundingClientRect()
      if (
        box.top !== last.top ||
        box.left !== last.left ||
        box.bottom !== last.bottom ||
        box.right !== last.right
      ) {
        last = box
        measure()
      }
      frame = requestAnimationFrame(tick)
    }
    let frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [anchorRef, measure])

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

  const isMenu = role === 'menu'

  // A keyboard-opened menu takes the caret: the marked current item when one
  // exists, else the first enabled one. Runs once placed (a hidden layer
  // cannot take focus), skips when content already focused itself -- the model
  // filter's autofocus keeps its caret -- and pointer opens never steal.
  useLayoutEffect(() => {
    if (!isMenu || placement === null || !lastInputWasKeyboard) return
    const menu = menuRef.current
    if (menu === null || menu.contains(document.activeElement)) return
    const items = enabledItems(menu)
    const current = items.find((el) => el.getAttribute('aria-current') === 'true')
    ;(current ?? items[0])?.focus({ preventScroll: true })
  }, [isMenu, placement])

  useEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    overlayEnter(menu)
    const onKey = (ev: KeyboardEvent) => {
      // only the topmost layer answers, and never a press claimed elsewhere
      if (!overlayTopmost(menu) || ev.defaultPrevented) return
      if (ev.isComposing) return // an IME mid-composition keeps its keys
      // chords like Ctrl+Escape belong to the platform, never to a layer
      const plain = !ev.ctrlKey && !ev.metaKey && !ev.altKey
      if (plain && ev.key === 'Escape') {
        closeRef.current()
        return
      }
      if (!isMenu || !plain) return
      onMenuKey(ev, menu, anchorRef.current, () => closeRef.current())
    }
    const onPointerDown = (ev: PointerEvent) => {
      const target = ev.target as Node
      // the trigger toggles itself, inside the menu is this component's ground
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return
      closeRef.current()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      // leave the stack before restoring focus, so a popover still open
      // beneath never sees its own Escape swallowed by this close
      overlayLeave(menu)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
      if (restoreTarget !== null && restoreTarget.isConnected) restoreTarget.focus()
    }
  }, [anchorRef, isMenu, restoreTarget])

  // hidden until the first measure, so an unplaced layer never flashes at (0,0)
  return createPortal(
    <div
      ref={menuRef}
      role={role}
      {...rest}
      style={{
        ...rest.style,
        position: 'fixed',
        visibility: placement ? undefined : 'hidden',
        left: placement?.left,
        top: placement?.top,
        minWidth: placement?.minWidth,
      }}
    >
      {children}
    </div>,
    document.body,
  )
}

// onMenuKey drives a role=menu layer's roving focus: arrows walk the enabled
// items with wrap-around, Home and End jump to the ends, and any plain Tab
// closes so the browser's focus walk never strands behind the visible menu.
// Presses in editable content keep their native meaning, and strangers'
// carets are left alone -- only items and the trigger answer.
function onMenuKey(
  ev: KeyboardEvent,
  menu: HTMLElement,
  anchor: HTMLElement | null,
  close: () => void,
): void {
  // presses in a text field keep their native meaning: the model menu's
  // filter drives results, not item focus
  const target = ev.target
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
  ) {
    return
  }
  const active = document.activeElement
  if (ev.key === 'Tab') {
    // closing restores the opener, then the walk continues from there
    close()
    return
  }
  const items = enabledItems(menu)
  let at = items.indexOf(active as HTMLElement)
  if (at < 0 && active !== anchor) return // a caret elsewhere keeps its keys
  switch (ev.key) {
    case 'ArrowDown':
      ev.preventDefault() // page scroll never escapes the menu
      at = at < 0 ? 0 : (at + 1) % items.length
      break
    case 'ArrowUp':
      ev.preventDefault()
      at = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length
      break
    case 'Home':
      ev.preventDefault()
      at = 0
      break
    case 'End':
      ev.preventDefault()
      at = items.length - 1
      break
    default:
      return // Enter and Space activate the focused native item themselves
  }
  items[at]?.focus()
}

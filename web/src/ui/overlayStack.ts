import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

// Open overlay layers, outermost first. ModalShell cards, MenuPopover layers
// and the mobile sheets and pushed screens share this one order, so exactly
// the topmost layer answers Escape and key bindings that act on page content
// stand down behind any open layer.
const overlays: HTMLElement[] = []

export function overlayOpen(): boolean {
  return overlays.length > 0
}

export function overlayEnter(el: HTMLElement): void {
  overlays.push(el)
}

// overlayLeave removes a layer as it closes, so a reopened layer can never
// shadow the one beneath it with a stale entry.
export function overlayLeave(el: HTMLElement): void {
  const at = overlays.indexOf(el)
  if (at >= 0) overlays.splice(at, 1)
}

export function overlayTopmost(el: HTMLElement): boolean {
  return overlays[overlays.length - 1] === el
}

// useOverlayDismiss wires one overlay layer into the shared stack for as long
// as it is mounted: Escape closes it while it is the topmost layer, and
// unmounting returns focus to the element focused when the layer opened.
export function useOverlayDismiss<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onClose: () => void,
): void {
  // latest onClose, so the key listener never resubscribes
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  // captured once at first render on purpose: content-level autoFocus only
  // fires later, at commit, so this stays the element closing hands focus
  // back to. ModalShell and MenuPopover keep the same capture
  const [restore] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )

  useEffect(() => {
    const el = ref.current
    if (el === null) return
    overlayEnter(el)

    const onKey = (ev: KeyboardEvent) => {
      // only the topmost layer answers, and never a press claimed elsewhere
      if (ev.key !== 'Escape' || ev.ctrlKey || ev.metaKey || ev.altKey) return
      if (ev.defaultPrevented || !overlayTopmost(el)) return
      closeRef.current()
    }
    window.addEventListener('keydown', onKey)

    return () => {
      // leave the stack before restoring focus, so a layer still open beneath
      // never recaptures the caret this close is handing back
      overlayLeave(el)
      window.removeEventListener('keydown', onKey)
      if (restore !== null && restore.isConnected) restore.focus()
    }
  }, [ref, restore])
}

import { useEffect } from 'react'
import type { RefObject } from 'react'

import { cycleFocus } from './focusTrap'
import { overlayTopmost } from './overlayStack'

// useFocusTrap holds one overlay layer's focus contract for as long as it
// mounts: opening takes focus into the panel, plain Tab presses cycle inside
// it, and focus that escapes is pulled back, each only while the layer is the
// topmost one. Registration, Escape and the focus restore on close stay with
// useOverlayDismiss, which must be called before this hook: a layer still
// open beneath recaptures focus moves made before this one joins the stack.
export function useFocusTrap<T extends HTMLElement>(ref: RefObject<T | null>): void {
  useEffect(() => {
    const panel = ref.current
    if (panel === null) return

    // content carrying autoFocus keeps its caret, otherwise the panel takes
    // it, so Tab starts inside the layer, never behind it
    if (!panel.contains(document.activeElement)) panel.focus()

    const onWindowKey = (ev: KeyboardEvent) => {
      // only the topmost layer answers, and never a press claimed elsewhere
      if (!overlayTopmost(panel) || ev.defaultPrevented) return
      // chords like Ctrl+Tab belong to the platform, never to a layer
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return
      if (ev.key === 'Tab') cycleFocus(panel, ev)
    }

    // focusin recaptures caret escapes the Tab trap cannot see: autofocus
    // mounting behind this layer, or a programmatic move elsewhere
    const onFocusIn = (ev: FocusEvent) => {
      if (!overlayTopmost(panel)) return
      if (ev.target instanceof Node && panel.contains(ev.target)) return
      panel.focus()
    }

    window.addEventListener('keydown', onWindowKey)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      window.removeEventListener('keydown', onWindowKey)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [ref])
}

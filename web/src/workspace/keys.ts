// Keyboard plumbing shared by both workspace modes. Plain keys drive the
// focus queue and pane digits, mod (Ctrl/Cmd) drives tile management, Alt
// arrows resize. Editable targets always win: typing in the composer or a
// dialog answer must never move the workspace. An event another listener
// already claimed (defaultPrevented) is left alone entirely, and the digits
// rest while a focused pane's head dialog answers them itself.
import { useEffect, useRef } from 'react'

import { caretInInput, dialogDigitsClaimed } from '../session/dialogKeys'
import { modalOpen } from '../ui/ModalShell'

export type Direction = 'left' | 'right' | 'up' | 'down'

export interface WorkspaceKeyHandlers {
  onNext?: () => void // j
  onPrevious?: () => void // k
  onOpen?: () => void // Enter
  onReview?: () => void // r
  onDigit?: (position: number) => void // 1..9
  onEscape?: () => void
  onShortcuts?: () => void // ?
  onPaneClose?: () => void // mod+w
  onSplitRight?: () => void // mod+\
  onSplitDown?: () => void // mod+shift+\
  onFocusDirection?: (dir: Direction) => void // mod+arrow
  onResize?: (dir: Direction) => void // alt+arrow
}

// useWorkspaceKeys binds the workspace's global keys; pass null handlers to
// unbind. Handled events preventDefault so the browser never scrolls or
// closes the tab out from under the shortcut.
export function useWorkspaceKeys(handlers: WorkspaceKeyHandlers): void {
  const ref = useRef(handlers)
  useEffect(() => {
    ref.current = handlers // the key effect below always reads the latest
  }, [handlers])

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      // an earlier listener that claimed the event wins, e.g. the viewed
      // session's Escape interrupt
      if (ev.defaultPrevented) return
      // editable targets win; behind any open ModalShell every binding rests,
      // leaving keys to the dialog instead of rows the backdrop hides
      if (caretInInput(ev.target) || modalOpen()) return
      const h = ref.current
      const mod = ev.ctrlKey || ev.metaKey

      if (ev.key === 'Escape' && !mod && !ev.altKey) {
        h.onEscape?.()
        return
      }
      if (ev.key === '?' && !mod && !ev.altKey) {
        ev.preventDefault()
        h.onShortcuts?.()
        return
      }
      if (mod && !ev.altKey) {
        // Shift turns '\' into '|', so splits match the physical key through
        // ev.code instead of the produced character.
        if (ev.code === 'Backslash') {
          ev.preventDefault()
          if (ev.shiftKey) h.onSplitDown?.()
          else h.onSplitRight?.()
          return
        }
        switch (ev.key.toLowerCase()) {
          case 'w':
            ev.preventDefault()
            h.onPaneClose?.()
            return
          case 'arrowleft':
            ev.preventDefault()
            h.onFocusDirection?.('left')
            return
          case 'arrowright':
            ev.preventDefault()
            h.onFocusDirection?.('right')
            return
          case 'arrowup':
            ev.preventDefault()
            h.onFocusDirection?.('up')
            return
          case 'arrowdown':
            ev.preventDefault()
            h.onFocusDirection?.('down')
            return
          default:
            return
        }
      }
      if (ev.altKey && !mod) {
        switch (ev.key) {
          case 'ArrowLeft':
            ev.preventDefault()
            h.onResize?.('left')
            return
          case 'ArrowRight':
            ev.preventDefault()
            h.onResize?.('right')
            return
          case 'ArrowUp':
            ev.preventDefault()
            h.onResize?.('up')
            return
          case 'ArrowDown':
            ev.preventDefault()
            h.onResize?.('down')
            return
          default:
            return
        }
      }
      if (mod || ev.altKey) return

      // Plain keys preventDefault only when a handler is bound, so unclaimed
      // keys keep browser semantics like Enter activating a focused control.
      const fire = (fn?: () => void) => {
        if (!fn) return
        ev.preventDefault()
        fn()
      }
      switch (ev.key) {
        case 'j':
          fire(h.onNext)
          return
        case 'k':
          fire(h.onPrevious)
          return
        case 'Enter':
          fire(h.onOpen)
          return
        case 'r':
          fire(h.onReview)
          return
        default:
          // the focused pane's head dialog owns the digits while it answers
          if (/^[1-9]$/.test(ev.key) && h.onDigit && !dialogDigitsClaimed()) {
            ev.preventDefault()
            h.onDigit(Number(ev.key))
          }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

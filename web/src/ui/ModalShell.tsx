import { useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { cycleFocus } from './focusTrap'
import { overlayEnter, overlayLeave, overlayTopmost } from './overlayStack'

// ModalShell is the one dialog chrome every centered modal shares: children
// render in a `card modal` over a fixed backdrop. A backdrop click or plain
// Escape calls `onClose`, Tab cycles inside, focus that escapes is pulled back
// while open, and closing returns focus to the element focused before opening.
// `label` names the dialog for assistive technology; `className` adds classes
// beside `card modal` so per-dialog widths still apply (e.g. rename-modal);
// `showClose` adds a visible × in the card's corner beside the Esc convention.
// `onKey`, when set, receives every other plain keydown while this shell is
// the topmost layer and the press is unclaimed, so dialog content can bind
// its own keys under the same stack discipline (the shortcut overlay's ?
// rides it).
export function ModalShell({
  label,
  className,
  showClose = false,
  onKey,
  onClose,
  children,
}: {
  label: string
  className?: string
  showClose?: boolean
  onKey?: (ev: KeyboardEvent) => void
  onClose: () => void
  children: ReactNode
}): ReactElement {
  const cardRef = useRef<HTMLDivElement>(null)
  // captured once at first render on purpose: content-level autoFocus only
  // fires later, at commit, so this is still the element focus returns to
  const [restoreTarget] = useState(() => document.activeElement as HTMLElement | null)

  // latest onClose and onKey, so the window listener never resubscribes
  const closeRef = useRef(onClose)
  const keyRef = useRef(onKey)
  useEffect(() => {
    closeRef.current = onClose
    keyRef.current = onKey
  })

  useEffect(() => {
    const card = cardRef.current
    if (card === null) return

    overlayEnter(card)
    // content carrying autoFocus keeps its caret; otherwise the card takes it,
    // so typing starts inside the dialog, never behind the backdrop
    if (!card.contains(document.activeElement)) card.focus()

    const topmost = () => overlayTopmost(card)

    const onWindowKey = (ev: KeyboardEvent) => {
      // only the topmost layer answers, and never a press claimed elsewhere
      if (!topmost() || ev.defaultPrevented) return
      // chords like Ctrl+Escape belong to the platform, never to a layer;
      // Shift stays free because keys like ? arrive shifted
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return
      if (ev.key === 'Escape') closeRef.current()
      else if (ev.key === 'Tab') cycleFocus(card, ev)
      else keyRef.current?.(ev)
    }

    // focusin recaptures caret escapes the Tab trap cannot see: autofocus
    // mounting behind this backdrop, or a programmatic move elsewhere
    const onFocusIn = (ev: FocusEvent) => {
      if (!topmost()) return
      if (ev.target instanceof Node && card.contains(ev.target)) return
      card.focus()
    }

    window.addEventListener('keydown', onWindowKey)
    document.addEventListener('focusin', onFocusIn)

    return () => {
      // leave the stack before restoring focus, so a shell still open beneath
      // never recaptures the caret this close is handing back
      overlayLeave(card)
      window.removeEventListener('keydown', onWindowKey)
      document.removeEventListener('focusin', onFocusIn)
      if (restoreTarget !== null && restoreTarget.isConnected) restoreTarget.focus()
    }
  }, [restoreTarget])

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={cardRef}
        className={className === undefined ? 'card modal' : `card modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(ev) => ev.stopPropagation()}
      >
        {showClose && (
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        )}
        {children}
      </div>
    </div>
  )
}

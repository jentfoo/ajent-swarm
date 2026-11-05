import { useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

// One selector for what Tab cycles through inside a dialog: the disabled and
// hidden cases the DOM itself can express. Modal content here renders
// conditionally with React, so no layout-based visibility check rides along.
const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([type="hidden"]):not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

// Open shells, outermost first. Only the topmost answers keys and focus
// escapes, so stacked dialogs never fight over one press or the caret.
const openShells: HTMLElement[] = []

// modalOpen reports whether any ModalShell currently holds the screen; key
// bindings that act on page content read this and stand down behind it.
export function modalOpen(): boolean {
  return openShells.length > 0
}

// cycleFocus spends one Tab press inside `card`: focus steps through the
// card's own controls, wraps at both ends, and holds on the card when nothing
// inside is focusable.
function cycleFocus(card: HTMLElement, ev: KeyboardEvent): void {
  const items = Array.from(card.querySelectorAll<HTMLElement>(focusableSelector))
  ev.preventDefault()
  if (items.length === 0) return

  // a caret outside the controls, or on the card itself, enters through
  // whichever end the direction reaches first
  const at = items.indexOf(document.activeElement as HTMLElement)
  const next =
    at < 0
      ? items[ev.shiftKey ? items.length - 1 : 0]
      : items[(at + (ev.shiftKey ? -1 : 1) + items.length) % items.length]
  next.focus()
}

// ModalShell is the one dialog chrome every centered modal shares: children
// render in a `card modal` over a fixed backdrop. A backdrop click or Escape
// calls `onClose`, Tab cycles inside, focus that escapes is pulled back while
// open, and closing returns focus to the element focused before opening.
// `label` names the dialog for assistive technology; `className` adds classes
// beside `card modal` so per-dialog widths still apply (e.g. rename-modal).
export function ModalShell({
  label,
  className,
  onClose,
  children,
}: {
  label: string
  className?: string
  onClose: () => void
  children: ReactNode
}): ReactElement {
  const cardRef = useRef<HTMLDivElement>(null)
  // captured once at first render on purpose: content-level autoFocus only
  // fires later, at commit, so this is still the element focus returns to
  const [restoreTarget] = useState(() => document.activeElement as HTMLElement | null)

  // latest onClose, so the listeners below never resubscribe
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  useEffect(() => {
    const card = cardRef.current
    if (card === null) return

    openShells.push(card)
    // content carrying autoFocus keeps its caret; otherwise the card takes it,
    // so typing starts inside the dialog, never behind the backdrop
    if (!card.contains(document.activeElement)) card.focus()

    const topmost = () => openShells[openShells.length - 1] === card

    const onKey = (ev: KeyboardEvent) => {
      if (!topmost() || ev.defaultPrevented) return
      if (ev.key === 'Escape') closeRef.current()
      else if (ev.key === 'Tab' && !ev.altKey && !ev.ctrlKey && !ev.metaKey) cycleFocus(card, ev)
    }

    // focusin recaptures caret escapes the Tab trap cannot see: autofocus
    // mounting behind this backdrop, or a programmatic move elsewhere
    const onFocusIn = (ev: FocusEvent) => {
      if (!topmost()) return
      if (ev.target instanceof Node && card.contains(ev.target)) return
      card.focus()
    }

    window.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onFocusIn)

    return () => {
      // leave the stack before restoring focus, so a shell still open beneath
      // never recaptures the caret this close is handing back
      const at = openShells.indexOf(card)
      if (at >= 0) openShells.splice(at, 1)
      window.removeEventListener('keydown', onKey)
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
        {children}
      </div>
    </div>
  )
}

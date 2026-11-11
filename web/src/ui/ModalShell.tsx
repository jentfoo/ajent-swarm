import { createContext, useCallback, useEffect, useContext, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { overlayTopmost, useOverlayDismiss } from './overlayStack'
import { useFocusTrap } from './useFocusTrap'
import { useOverlayBack } from './useOverlayBack'

// HistoryShield ties one dialog to browser history for as long as it mounts:
// platform back and the browser back button call `onClose` instead of
// unmounting whatever hosts the dialog. It renders nothing itself.
function HistoryShield({ onClose }: { onClose: () => void }) {
  useOverlayBack(onClose)
  return null
}

// RequestCloseContext carries a shell's guarded close to its content: an
// in-form dismiss button rides the same discard confirm as Escape and ×.
const RequestCloseContext = createContext<(() => void) | null>(null)

// ModalShell is the one dialog chrome every centered modal shares: children
// render in a `card modal` over a fixed backdrop. A backdrop click or plain
// Escape calls `onClose`, Tab cycles inside, focus that escapes is pulled back
// while open, and closing returns focus to the element focused before opening.
// `label` names the dialog for assistive technology, `className` adds classes
// beside `card modal` so per-dialog widths still apply (e.g. rename-modal)
// `showClose` adds a visible × in the card's corner beside the Esc convention.
// `onKey`, when set, receives every other plain keydown while this shell is
// the topmost layer and the press is unclaimed, so dialog content can bind
// its own keys under the same stack discipline (the shortcut overlay's ?
// rides it).
// Passing `dirty` opts the dialog into the discard guard for forms that hold
// unsaved input: Escape, the backdrop, the × and browser back confirm before
// closing while dirty holds. It also mounts a history entry for the dialog's
// lifetime, so platform back reaches that same guard instead of unmounting the
// form behind it. Content Cancel buttons ride that guard through
// ModalCancelButton. Omit `dirty` to close on every affordance directly.
export function ModalShell({
  label,
  className,
  showClose = false,
  onKey,
  dirty,
  onClose,
  children,
}: {
  label: string
  className?: string
  showClose?: boolean
  onKey?: (ev: KeyboardEvent) => void
  // any value mounts the history guard; true makes close requests ask first
  dirty?: boolean
  onClose: () => void
  children: ReactNode
}): ReactElement {
  const cardRef = useRef<HTMLDivElement>(null)

  const [confirming, setConfirming] = useState(false)
  // remount key for the shield: a back-initiated request lands off the dialog's
  // own entry, so remounting re-anchors one beneath the current position and
  // later backs keep hitting the guard instead of leaving the page behind it
  const [shieldEpoch, setShieldEpoch] = useState(0)

  // latest onClose and onKey, so the window listener never resubscribes while
  // the guard reads current state through the refs
  const closeRef = useRef(onClose)
  const keyRef = useRef(onKey)
  const dirtyRef = useRef(dirty === true)

  // requestClose is every exit affordance's single entry point: while dirty
  // holds it asks first instead of discarding typed content silently. It only
  // reads the refs, so one stable identity serves the window listener and the
  // content context alike.
  const requestClose = useCallback(() => {
    if (!dirtyRef.current) {
      closeRef.current()
      return
    }
    setConfirming(true)
  }, [])

  // backRequested answers platform back, which has already stepped off the
  // dialog's own entry. Only it re-anchors the shield: affordances that did
  // not move history must leave their entry current, or every request would
  // strand a dead entry behind the remount and grow the back stack.
  const backRequested = () => {
    setShieldEpoch((epoch) => epoch + 1)
    requestClose()
  }

  // keepEditing answers the confirm: the dialog's shield sits directly beneath
  // the confirm's own, so dismissing the question leaves this dialog guarded.
  const keepEditing = () => setConfirming(false)

  // discard settles the confirm into the real close the viewer asked for.
  const discard = () => {
    setConfirming(false)
    closeRef.current()
  }

  useEffect(() => {
    closeRef.current = onClose
    keyRef.current = onKey
    dirtyRef.current = dirty === true
  })

  // the shared layer contract: useOverlayDismiss owns stack order, Escape
  // and the focus restore on close, useFocusTrap owns Tab containment and
  // focus recapture while this shell is the topmost layer
  useOverlayDismiss(cardRef, requestClose)
  useFocusTrap(cardRef)

  // onKey receives the plain keydowns neither the dismiss nor the trap
  // listener owns, only while this shell is the topmost layer
  useEffect(() => {
    const card = cardRef.current
    if (card === null) return

    const onWindowKey = (ev: KeyboardEvent) => {
      // only the topmost layer answers, and never a press claimed elsewhere
      if (!overlayTopmost(card) || ev.defaultPrevented) return
      // chords like Ctrl+X belong to the platform, never to a layer
      // Shift stays free because keys like ? arrive shifted
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return
      if (ev.key === 'Escape' || ev.key === 'Tab') return
      keyRef.current?.(ev)
    }

    window.addEventListener('keydown', onWindowKey)
    return () => window.removeEventListener('keydown', onWindowKey)
  }, [])

  return (
    <>
      {dirty !== undefined && <HistoryShield key={shieldEpoch} onClose={backRequested} />}
      <div className="modal-backdrop" role="presentation" onClick={requestClose}>
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
            <button type="button" className="modal-close" aria-label="Close" onClick={requestClose}>
              ×
            </button>
          )}
          <RequestCloseContext.Provider value={requestClose}>
            {children}
          </RequestCloseContext.Provider>
        </div>
      </div>
      {confirming && (
        <>
          {/* a second back while asking cancels the question, never the dialog */}
          <HistoryShield onClose={keepEditing} />
          <ModalShell label="Discard changes?" className="discard-modal" onClose={keepEditing}>
            <h2 style={{ marginTop: 0, fontSize: 'inherit' }}>Discard unsaved changes?</h2>
            <p className="muted">Edits to this form are not saved yet.</p>
            <div className="dialog-actions">
              <button type="button" onClick={keepEditing}>
                Keep editing
              </button>
              <button type="button" onClick={discard}>
                Discard
              </button>
            </div>
          </ModalShell>
        </>
      )}
    </>
  )
}

// ModalCancelButton is a form dialog's standard Cancel button: it rides its
// shell's guarded close, so dirty drafts ask before dropping exactly like the
// chrome does.
export function ModalCancelButton({ disabled = false }: { disabled?: boolean }): ReactElement {
  const requestClose = useContext(RequestCloseContext)
  if (requestClose === null) throw new Error('ModalCancelButton outside ModalShell')
  return (
    <button type="button" onClick={requestClose} disabled={disabled}>
      Cancel
    </button>
  )
}

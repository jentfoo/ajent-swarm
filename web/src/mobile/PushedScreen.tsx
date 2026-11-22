import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { ModalShell } from '../ui/ModalShell'
import { useFocusTrap } from '../ui/useFocusTrap'
import { useOverlayBack } from '../ui/useOverlayBack'
import { useOverlayDismiss } from '../ui/overlayStack'

// BackShield ties one layer to browser history for as long as it mounts:
// platform back calls `onClose` instead of leaving the page behind it.
function BackShield({ onClose }: { onClose: () => void }) {
  useOverlayBack(onClose)
  return null
}

// PushedScreen is the shared chrome for the full-screen panels that read as
// layers on phones (tools, agent settings): a fixed panel titled by `title`, a
// Back header above the scrollable children. Escape closes through the shared
// overlay stack, opening pushes a history entry so the platform back gesture
// closes the layer instead of leaving the session. The panel rides the same
// focus contract as ModalShell and BottomSheet: opening takes focus into the
// panel, Tab cycles inside it, and closing restores focus to what opened it.
// Passing `dirty` opts the layer into the discard guard forms need: platform
// back, ← Back and Escape confirm before dropping typed content, the same
// contract ModalShell keeps. Callers mount it only while open.
export function PushedScreen({
  title,
  dirty,
  onClose,
  children,
}: {
  title: string
  // any value mounts the back guard; true makes close requests ask first
  dirty?: boolean
  onClose: () => void
  children: ReactNode
}): ReactElement {
  const panelRef = useRef<HTMLElement>(null)
  const [confirming, setConfirming] = useState(false)
  // remount key for the back shield: a back-initiated request lands off the
  // layer's own entry, so remounting re-anchors one beneath the current
  // position and later backs keep hitting the guard instead of the page
  const [shieldEpoch, setShieldEpoch] = useState(0)

  // latest close and dirty flags, so the stable requestClose reads current
  // state through refs and the listeners never resubscribe
  const closeRef = useRef(onClose)
  const dirtyRef = useRef(dirty === true)
  useEffect(() => {
    closeRef.current = onClose
    dirtyRef.current = dirty === true
  })

  // requestClose is every exit affordance's single entry point: while dirty
  // holds it asks first instead of discarding typed content silently
  const requestClose = useCallback(() => {
    if (!dirtyRef.current) {
      closeRef.current()
      return
    }
    setConfirming(true)
  }, [])

  // backRequested answers platform back, which already stepped off the
  // layer's own entry
  const backRequested = () => {
    setShieldEpoch((epoch) => epoch + 1)
    requestClose()
  }

  // keepEditing answers the confirm: dismissing the question leaves the
  // layer open, still guarded
  const keepEditing = useCallback(() => setConfirming(false), [])
  const discard = useCallback(() => {
    setConfirming(false)
    closeRef.current()
  }, [])

  useOverlayDismiss(panelRef, requestClose)
  useFocusTrap(panelRef)

  return (
    <section
      className="pushed-screen"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      ref={panelRef}
    >
      <header className="pushed-header">
        <button type="button" onClick={requestClose}>
          ← Back
        </button>
        <h2>{title}</h2>
      </header>
      {children}
      <BackShield key={shieldEpoch} onClose={backRequested} />
      {confirming && (
        <>
          {/* a second back while asking cancels the question, never the layer */}
          <BackShield onClose={keepEditing} />
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
    </section>
  )
}

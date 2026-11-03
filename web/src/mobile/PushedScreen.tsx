import { useRef } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { useOverlayDismiss } from '../ui/overlayStack'
import { useOverlayBack } from './useOverlayBack'

// PushedScreen is the shared chrome for the full-screen panels that read as
// layers on phones (tools, agent settings): a fixed panel titled by `title`, a
// Back header above the scrollable children. Escape closes through the shared
// overlay stack, opening pushes a history entry so the platform back gesture
// closes the layer instead of leaving the session, and closing restores focus
// to what opened it. Callers mount it only while open.
export function PushedScreen({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}): ReactElement {
  const panelRef = useRef<HTMLElement>(null)
  useOverlayDismiss(panelRef, onClose)
  useOverlayBack(onClose)

  return (
    <section className="pushed-screen" role="dialog" aria-label={title} ref={panelRef}>
      <header className="pushed-header">
        <button type="button" onClick={onClose}>
          ← Back
        </button>
        <h2>{title}</h2>
      </header>
      {children}
    </section>
  )
}

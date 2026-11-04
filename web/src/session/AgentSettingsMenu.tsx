import { useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { SettingsMenu } from './SettingsMenu'

// HamburgerDialog is the open/close shell both ☰ settings menus share: a
// trigger plus, when open, children in a centered modal so edge-of-grid cards
// keep the menu on page. `label` names trigger and dialog; `title` overrides
// the trigger hover text.
export function HamburgerDialog({
  label,
  title,
  children,
}: {
  label: string
  title?: string
  children: ReactNode
}): ReactElement {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        title={title ?? label}
        onClick={() => setOpen(true)}
      >
        ☰
      </button>
      {open && (
        <div className="modal-backdrop" role="presentation" onClick={() => setOpen(false)}>
          <div
            className="card modal settings-modal"
            role="dialog"
            aria-label={label}
            onClick={(ev) => ev.stopPropagation()}
          >
            {children}
          </div>
        </div>
      )}
    </>
  )
}

// AgentSettingsMenu is the ☰ affordance a session's own chrome carries: the
// shared settings.get/settings.set menu over that session's control socket.
// It lives in the chat header and on session cards, so a session is always
// the context for its agent settings, never a picker elsewhere.
export function AgentSettingsMenu({ sessionId }: { sessionId: string }): ReactElement {
  return (
    <HamburgerDialog label="Agent settings" title="Agent settings for this session">
      <SettingsMenu sessionId={sessionId} />
    </HamburgerDialog>
  )
}

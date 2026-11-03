import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { SettingsMenu } from './SettingsMenu'

// AgentSettingsMenu is the ☰ affordance a session's own chrome carries: the
// shared settings.get/settings.set menu over that session's control socket.
// It lives in the chat header and on session cards, so a session is always
// the context for its agent settings, never a picker elsewhere.
export function AgentSettingsMenu({ sessionId }: { sessionId: string }): ReactElement {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (ev: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(ev.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  return (
    <div ref={menuRef} className="hamburger-menu">
      <button
        type="button"
        aria-label="Agent settings"
        aria-expanded={open}
        title="Agent settings for this session"
        onClick={() => setOpen((v) => !v)}
      >
        ☰
      </button>
      {open && (
        <div className="hamburger-pop card" role="dialog" aria-label="Agent settings">
          <SettingsMenu sessionId={sessionId} />
        </div>
      )}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { TitleModelSelect } from './TitleModelSelect'

// GlobalSettingsMenu is the top-bar ☰: swarm's own settings, which need no
// session behind them. Per-session agent settings moved into the chat header
// and session cards, where the session they edit is the one on screen.
export function GlobalSettingsMenu(): ReactElement {
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
        aria-label="Global settings"
        aria-expanded={open}
        title="Global settings"
        onClick={() => setOpen((v) => !v)}
      >
        ☰
      </button>
      {open && (
        <div className="hamburger-pop card" role="dialog" aria-label="Global settings">
          <h3 style={{ margin: 0, fontSize: 'inherit' }}>Global settings</h3>
          <TitleModelSelect />
          <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-small)' }}>
            Per-session agent settings live in each chat's ☰ header.
          </p>
        </div>
      )}
    </div>
  )
}

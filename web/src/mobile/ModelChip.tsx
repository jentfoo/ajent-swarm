import { useEffect, useRef, useState } from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { CtlState } from '../api/types'
import { Spinner } from '../session/Spinner'

// ModelChip is the compact header model control: the short label plus a
// spinner while working. The menu lists models.get's registry directly and
// switches through model.set — no picker dialog to ride or cancel.
export function ModelChip({
  sessionId,
  snap,
  onToast,
}: {
  sessionId: string
  snap: CtlState
  onToast: (text: string, level?: 'info' | 'error') => void
}) {
  const [open, setOpen] = useState(false)
  // the last listing reply, keyed to the session it answered; rendering only
  // when it belongs here keeps another session's registry from flashing in
  const [fetched, setFetched] = useState<{
    forSession: string
    keys: string[]
    active: string
  } | null>(null)
  const [busy, setBusy] = useState(false) // a model.set is in flight
  const working = snap.running || snap.spinning
  const menuRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (ev: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(ev.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  // every open lists fresh; closing mid-flight drops the reply, so a stale
  // cycle can never reopen the menu or apply another session's listing
  useEffect(() => {
    if (!open) return
    let alive = true
    const forSession = sessionId
    sessionAPI
      .models(sessionId)
      .then((listing) => {
        if (alive) {
          setFetched({
            forSession,
            keys: listing.models.map((m) => m.key),
            active: listing.active || snap.model.key,
          })
        }
      })
      .catch((err: unknown) => {
        if (alive) onToast(err instanceof ApiError ? err.message : 'Model listing failed.', 'error')
      })
    return () => {
      alive = false
    }
  }, [open, sessionId, snap.model.key, onToast])

  const pick = async (key: string) => {
    if (busy) return
    setBusy(true)
    try {
      await sessionAPI.setModel(sessionId, key)
      setOpen(false)
      // the switch may queue behind a running turn; status.model announces it
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Model change refused.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const listed = fetched !== null && fetched.forSession === sessionId
  return (
    <span ref={menuRef} className="model-chip-wrap">
      <button
        type="button"
        className="badge accent model-chip"
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        {snap.model.short || snap.model.key || 'model'}
        {working && <Spinner state={working ? 'wait' : 'idle'} />}
      </button>
      {open && listed && (
        <div className="menu card model-menu-list" role="menu">
          {fetched.keys.length === 0 && <span className="muted menu-empty">No models listed.</span>}
          {fetched.keys.map((key) => (
            <button key={key} type="button" role="menuitem" onClick={() => void pick(key)}>
              {key}
              {(key === fetched.active || key === snap.model.key) && (
                <span className="badge ok">current</span>
              )}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

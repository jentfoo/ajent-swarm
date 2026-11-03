import { useCallback, useState } from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { CtlState } from '../api/types'

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
  const [keys, setKeys] = useState<string[]>([])
  const [active, setActive] = useState('')
  const [busy, setBusy] = useState(false)
  const working = snap.running || snap.spinning

  const openMenu = useCallback(async () => {
    if (open) {
      setOpen(false)
      return
    }
    setBusy(true)
    try {
      const listing = await sessionAPI.models(sessionId)
      setKeys(listing.models.map((m) => m.key))
      setActive(listing.active || snap.model.key)
      setOpen(true)
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Model listing failed.', 'error')
    } finally {
      setBusy(false)
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

  return (
    <span className="model-chip-wrap">
      <button
        type="button"
        className="badge accent model-chip"
        disabled={busy}
        onClick={() => void openMenu()}
      >
        {snap.model.short || snap.model.key || 'model'}
        {working && (
          <span className="spinner" role="img" aria-label="running">
            ◌
          </span>
        )}
      </button>
      {open && (
        <div className="menu card model-menu-list" role="menu">
          {keys.map((key) => (
            <button key={key} type="button" role="menuitem" onClick={() => void pick(key)}>
              {key}
              {key === active && <span className="badge ok">current</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

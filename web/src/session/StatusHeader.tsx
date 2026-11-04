import { useCallback, useRef, useState } from 'react'
import type * as React from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { CtlState, ModelState } from '../api/types'
import { MenuPopover } from '../ui/MenuPopover'
import { AgentSettingsMenu } from './AgentSettingsMenu'
import { ToolsPanel } from './ToolsPanel'

// The permission gate's fixed upstream vocabulary; mode.set refuses anything
// else. Order matches ajent's own cycle so the menu reads as a progression.
const permissionModes = ['allow-read', 'auto', 'auto+write', 'allow-all', 'block-all']

// StatusHeader is the slim chrome above the transcript: identity (stored title
// beside the short session id) and action buttons only. Everything that reads
// at a glance (segments, context, queue, activity) lives in the status bar
// under the transcript. Sessions stop from the sessions tab; this header never
// tears one down. The ☰ here carries this session's agent settings.
export function StatusHeader({
  sessionId,
  snap,
  onToast,
  children,
}: {
  sessionId: string
  snap: CtlState
  onToast: (text: string, level?: 'info' | 'error') => void
  children?: React.ReactNode
}) {
  const [busy, setBusy] = useState(false)
  const working = snap.running || snap.spinning

  const interrupt = async () => {
    setBusy(true)
    try {
      await sessionAPI.interrupt(sessionId)
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Interrupt failed.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const label = snap.session.name || snap.session.id
  return (
    <div className="session-header">
      <h1 style={{ margin: 0, fontSize: 'inherit' }}>
        {label}
        {snap.session.name && snap.session.name !== snap.session.id && (
          <span className="muted mono header-session-id">{shortID(snap.session.id)}</span>
        )}
      </h1>
      {working ? (
        <span className="badge accent" aria-label="running">
          running
        </span>
      ) : (
        snap.idle && <span className="badge">idle</span>
      )}
      {busy && <span className="badge warn">stopping…</span>}
      <ModeMenu sessionId={sessionId} mode={snap.permission} onToast={onToast} />
      <ToolsPanel sessionId={sessionId} snap={snap} onToast={onToast} />
      <ModelMenu sessionId={sessionId} snap={snap} onToast={onToast} />
      {working && (
        <button type="button" onClick={() => void interrupt()} disabled={busy}>
          Interrupt
        </button>
      )}
      {children}
      <AgentSettingsMenu sessionId={sessionId} />
    </div>
  )
}

// shortID trims a session id for display beside its title.
function shortID(id: string): string {
  return id.length <= 12 ? id : id.slice(0, 8) + '…'
}

// ModeMenu picks the permission level straight from the fixed upstream
// vocabulary through mode.set. A session without a gate hides the menu.
export function ModeMenu({
  sessionId,
  mode,
  onToast,
}: {
  sessionId: string
  mode: string
  onToast: (text: string, level?: 'info' | 'error') => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const chipRef = useRef<HTMLButtonElement>(null)

  const pick = useCallback(
    async (next: string) => {
      if (busy || next === mode) {
        setOpen(false)
        return
      }
      setBusy(true)
      try {
        await sessionAPI.setMode(sessionId, next)
        setOpen(false)
        // the permission event re-renders the chip from the stream
      } catch (err) {
        onToast(err instanceof ApiError ? err.message : 'Mode change refused.', 'error')
      } finally {
        setBusy(false)
      }
    },
    [busy, mode, sessionId, onToast],
  )

  if (mode === '') return null // no gate exists on this session
  return (
    <div className="model-menu">
      <button
        ref={chipRef}
        type="button"
        className="badge mode-chip"
        disabled={busy}
        title="Permission mode"
        onClick={() => setOpen((v) => !v)}
      >
        mode: {mode}
      </button>
      {open && (
        <MenuPopover
          anchorRef={chipRef}
          role="menu"
          className="menu card"
          onClose={() => setOpen(false)}
        >
          {permissionModes.map((m) => (
            <button key={m} type="button" role="menuitem" onClick={() => void pick(m)}>
              {m}
              {m === mode && <span className="badge ok">current</span>}
            </button>
          ))}
        </MenuPopover>
      )}
    </div>
  )
}

// ModelMenu lists models.get's registry exactly as the running process
// resolved it and switches through model.set — no picker dialog to ride or
// cancel, and no user-config persist side effect. Refusals for unknown or
// ambiguous names surface as toasts with upstream's message.
function ModelMenu({
  sessionId,
  snap,
  onToast,
}: {
  sessionId: string
  snap: CtlState
  onToast: (text: string, level?: 'info' | 'error') => void
}) {
  const [open, setOpen] = useState(false)
  const [listing, setListing] = useState<ModelState[]>([])
  const [active, setActive] = useState('')
  const [busy, setBusy] = useState(false)
  const chipRef = useRef<HTMLButtonElement>(null)

  const openMenu = useCallback(async () => {
    if (open) {
      setOpen(false)
      return
    }
    setBusy(true)
    try {
      const res = await sessionAPI.models(sessionId)
      setListing(res.models ?? [])
      setActive(res.active || snap.model.key)
      setOpen(true)
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Model listing failed.', 'error')
    } finally {
      setBusy(false)
    }
  }, [open, sessionId, snap.model.key, onToast])

  const pick = useCallback(
    async (key: string) => {
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
    },
    [busy, sessionId, onToast],
  )

  const label = snap.model.short || snap.model.key || 'model'
  return (
    <div className="model-menu">
      <button
        ref={chipRef}
        type="button"
        className="badge accent model-chip"
        disabled={busy}
        title="Switch model"
        onClick={() => void openMenu()}
      >
        {label}
      </button>
      {open && (
        <MenuPopover
          anchorRef={chipRef}
          role="menu"
          className="menu card"
          onClose={() => setOpen(false)}
        >
          {listing.length === 0 && <span className="muted menu-empty">No models listed.</span>}
          {listing.map((m) => (
            <button
              key={m.key}
              type="button"
              role="menuitem"
              title={`${m.key}${m.window > 0 ? ` · ${m.window.toLocaleString()} token window` : ''}`}
              onClick={() => void pick(m.key)}
            >
              {m.short || m.key}
              {(active === m.key || snap.model.key === m.key) && (
                <span className="badge ok">current</span>
              )}
            </button>
          ))}
        </MenuPopover>
      )}
    </div>
  )
}

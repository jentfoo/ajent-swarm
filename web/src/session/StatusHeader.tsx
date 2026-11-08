import { useCallback, useRef, useState } from 'react'
import type * as React from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { CtlState } from '../api/types'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { sessionBusy } from '../state/eventApplier'
import { headerBadgeOf } from '../workspace/attention'
import { useWorkspace } from '../providers/workspace'
import { MenuPopover } from '../ui/MenuPopover'
import { ModelMenuItems } from '../ui/ModelMenuItems'
import { OverlayMenu } from '../ui/OverlayMenu'
import { useModelMenu } from '../ui/useModelMenu'
import { shortID } from './names'
import { useSessionLabel } from './useSessionLabel'
import { AgentSettingsMenu } from './AgentSettingsMenu'
import { StatusBadge } from './StatusBadge'
import { ToolsPanel } from './ToolsPanel'

// The permission gate's fixed upstream vocabulary; mode.set refuses anything
// else. Order matches ajent's own cycle so the menu reads as a progression.
const permissionModes = ['allow-read', 'auto', 'auto+write', 'allow-all', 'block-all']

// StatusHeader is the slim chrome above the transcript: identity (the shared
// listing label beside the short session id), the shared status badge and
// action buttons. Everything that reads at a glance (segments, context,
// queue, activity) lives in the status bar under the transcript. A running
// turn stops from the composer's Stop button; sessions exit from the
// sessions tab, so this header never tears one down. The ☰ here carries this
// session's agent settings.
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
  const working = sessionBusy(snap)
  // the badge reads the same derivation as the mobile header and the
  // switcher rows: needs-input outranks a turn still running behind it
  const { itemFor } = useWorkspace()
  // identity reads the swarm listing like the rail does, so a rename lands
  // with its refresh, and the short id rides beside any real label
  const label = useSessionLabel(sessionId)
  const short = shortID(sessionId)

  return (
    <div className="session-header">
      <h1 style={{ margin: 0, fontSize: 'inherit' }}>
        {label}
        {label !== short && <span className="muted mono header-session-id">{short}</span>}
      </h1>
      <StatusBadge status={headerBadgeOf(working, itemFor(sessionId))} />
      <ModeMenu sessionId={sessionId} mode={snap.permission} onToast={onToast} />
      <ToolsPanel sessionId={sessionId} snap={snap} onToast={onToast} />
      <ModelMenu sessionId={sessionId} snap={snap} onToast={onToast} />
      {children}
      <AgentSettingsMenu sessionId={sessionId} />
    </div>
  )
}

// ModeMenu picks the permission level straight from the fixed upstream
// vocabulary through mode.set. A session without a gate hides the menu.
// Coarse pointers bind the open menu to history, so platform back closes it
// instead of leaving the session; fine pointers keep MenuPopover alone, where
// browser back belongs to navigation.
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
  // read live rather than at import: tests stub the pointer class per render
  const touch = useMediaQuery('(pointer: coarse)')

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

  // one item list feeds either surface's popover
  const items = permissionModes.map((m) => (
    <button key={m} type="button" role="menuitem" onClick={() => void pick(m)}>
      {m}
      {m === mode && <span className="badge ok">current</span>}
    </button>
  ))

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
      {open &&
        (touch ? (
          <OverlayMenu anchorRef={chipRef} onClose={() => setOpen(false)}>
            {items}
          </OverlayMenu>
        ) : (
          <MenuPopover
            anchorRef={chipRef}
            role="menu"
            className="menu card"
            onClose={() => setOpen(false)}
          >
            {items}
          </MenuPopover>
        ))}
    </div>
  )
}

// ModelMenu lists models.get's registry exactly as the running process
// resolved it and switches through model.set — no picker dialog to ride or
// cancel, and no user-config persist side effect. Fetch, pick and busy state
// live in the shared useModelMenu controller; items render through the
// shared grouped ModelMenuItems, the same body the mobile chip uses.
// Refusals for unknown or ambiguous names surface as toasts with upstream's
// message.
function ModelMenu({
  sessionId,
  snap,
  onToast,
}: {
  sessionId: string
  snap: CtlState
  onToast: (text: string, level?: 'info' | 'error') => void
}) {
  const menu = useModelMenu(sessionId, snap.model.key, onToast)
  const chipRef = useRef<HTMLButtonElement>(null)

  const label = snap.model.short || snap.model.key || 'model'
  return (
    <div className="model-menu">
      <button
        ref={chipRef}
        type="button"
        className="badge accent model-chip"
        disabled={menu.busy}
        title="Switch model"
        onClick={() => void menu.toggle()}
      >
        {label}
      </button>
      {menu.open && (
        <MenuPopover anchorRef={chipRef} role="menu" className="menu card" onClose={menu.close}>
          <ModelMenuItems
            models={menu.models}
            active={menu.active}
            currentKey={snap.model.key}
            onPick={(key) => void menu.pick(key)}
          />
        </MenuPopover>
      )}
    </div>
  )
}

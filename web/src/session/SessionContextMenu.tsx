import { useCallback, useRef, useState } from 'react'
import type { MouseEvent, ReactElement } from 'react'

import { describeError } from '../api/errors'
import { sessions as sessionAPI } from '../api/endpoints'
import { childEnded } from '../api/types'
import { useArmedConfirm } from '../hooks/useArmedConfirm'
import { MenuPopover } from '../ui/MenuPopover'
import { PinIcon } from '../ui/icons'
import { useSwarm } from '../providers/swarm'
import { useWorkspace } from '../providers/workspace'

// SessionMenuPoint is where a context menu opened, the session it acts on,
// and an open counter so the inner body remounts per open and armed stop
// state never survives a close.
export interface SessionMenuPoint {
  x: number
  y: number
  sessionId: string
  epoch: number
}

// useSessionMenu is the open-state helper every surface shares: one menu at a
// time, opening already prevents the browser's own menu. Pointer-driven
// surfaces open through openSessionMenu, held-touch surfaces through
// openSessionMenuAt with the press point.
export function useSessionMenu(): {
  menu: SessionMenuPoint | null
  openSessionMenu: (ev: MouseEvent, sessionId: string) => void
  openSessionMenuAt: (x: number, y: number, sessionId: string) => void
  closeSessionMenu: () => void
} {
  const [menu, setMenu] = useState<SessionMenuPoint | null>(null)
  const epoch = useRef(0)
  const openAt = useCallback((x: number, y: number, sessionId: string) => {
    epoch.current += 1
    setMenu({ x, y, sessionId, epoch: epoch.current })
  }, [])
  return {
    menu,
    openSessionMenu: (ev, sessionId) => {
      ev.preventDefault()
      openAt(ev.clientX, ev.clientY, sessionId)
    },
    openSessionMenuAt: openAt,
    closeSessionMenu: () => setMenu(null),
  }
}

// SessionContextMenu is the right-click menu over a session surface: the
// pointer lands in an invisible zero-size span the menu anchors beside, so
// MenuPopover keeps its viewport flipping and overlay-stack dismissal. The
// body remounts per open (the epoch key), so the armed stop resets between
// opens. The pin entry leads: it flips the session's focus-rail pin, reading
// Pin or Unpin by the state it is about to leave. One entry queues a fresh
// follow-up session behind this one, landing
// the workspace provider's queue draft on the shared form shells, an optional
// chain entry (mobile rows) opens the pushed target picker; queue and chain
// show only while the session runs, an optional agent settings entry (mobile
// rows) opens that session's settings surface, an optional rename entry covers
// surfaces without an inline pencil (mobile rows), and the armed stop is the
// same guard the cards' stop buttons carry. Surfaces that keep their own stop
// button pass stop={false} to drop the entry (mobile rows).
export function SessionContextMenu({
  menu,
  onClose,
  onRename,
  onChain,
  onSettings,
  stop = true,
}: {
  menu: SessionMenuPoint | null
  onClose: () => void
  onRename?: () => void
  onChain?: () => void
  onSettings?: () => void
  stop?: boolean
}): ReactElement | null {
  if (menu === null) return null
  return (
    <MenuBody
      key={menu.epoch}
      menu={menu}
      onClose={onClose}
      onRename={onRename}
      onChain={onChain}
      onSettings={onSettings}
      stop={stop}
    />
  )
}

function MenuBody({
  menu,
  onClose,
  onRename,
  onChain,
  onSettings,
  stop: withStop,
}: {
  menu: SessionMenuPoint
  onClose: () => void
  onRename?: () => void
  onChain?: () => void
  onSettings?: () => void
  stop?: boolean
}): ReactElement {
  const { sessions, refreshSessions } = useSwarm()
  const { pinnedSessionIds, togglePinnedSession, setQueueDraft } = useWorkspace()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState('')
  // the ended tail keeps resume instead of stop, like the cards and rows do
  const ended = childEnded(sessions.find((s) => s.sessionId === menu.sessionId)?.state ?? '')

  const stop = async () => {
    setStopping(true)
    setError('')
    try {
      // the endpoint escalates on its own: /exit first, then signals for
      // swarm children, so one call is the direct stop
      await sessionAPI.stop(menu.sessionId)
      onClose()
      void refreshSessions() // rows re-badge now, not on the next poll
    } catch (err) {
      setError(describeError(err, 'Stop failed.'))
      setStopping(false)
    }
  }

  const confirm = useArmedConfirm(() => void stop(), { disabled: stopping })

  return (
    <>
      <span
        ref={anchorRef}
        aria-hidden="true"
        style={{ position: 'fixed', left: menu.x, top: menu.y, width: 0, height: 0 }}
      />
      <MenuPopover
        anchorRef={anchorRef}
        className="menu card"
        role="menu"
        aria-label="Session actions"
        onClose={onClose}
      >
        {/* pin leads the menu; the wording reads the state the flip leaves
            behind, and ended sessions keep it for their next live run */}
        <button
          type="button"
          role="menuitem"
          onClick={(ev) => {
            ev.stopPropagation()
            togglePinnedSession(menu.sessionId)
            onClose()
          }}
        >
          <PinIcon />
          {pinnedSessionIds.includes(menu.sessionId) ? 'Unpin' : 'Pin'}
        </button>
        {/* the portal bubbles clicks through the React tree into the row that
            opened the menu, every item stands that leak down */}
        {/* a stopped session has no next review point to hand off at, so
            queue and chain stand down for it */}
        {!ended && (
          <button
            type="button"
            role="menuitem"
            onClick={(ev) => {
              ev.stopPropagation()
              setQueueDraft({ parentId: menu.sessionId })
              onClose()
            }}
          >
            Queue follow up session…
          </button>
        )}
        {!ended && onChain && (
          <button
            type="button"
            role="menuitem"
            onClick={(ev) => {
              ev.stopPropagation()
              onChain()
              onClose()
            }}
          >
            Chain after…
          </button>
        )}
        {onSettings && (
          <button
            type="button"
            role="menuitem"
            onClick={(ev) => {
              ev.stopPropagation()
              onSettings()
              onClose()
            }}
          >
            Agent settings…
          </button>
        )}
        {onRename && (
          <button
            type="button"
            role="menuitem"
            onClick={(ev) => {
              ev.stopPropagation()
              onRename()
              onClose()
            }}
          >
            Rename…
          </button>
        )}
        {!ended && withStop && (
          <button
            type="button"
            role="menuitem"
            className={`danger${confirm.armed ? ' armed' : ''}`}
            onClick={(ev) => {
              ev.stopPropagation()
              confirm.onClick(ev)
            }}
            onBlur={confirm.onBlur}
            disabled={stopping}
          >
            {stopping ? 'Stopping…' : confirm.armed ? 'Stop?' : 'Stop session'}
          </button>
        )}
        {error !== '' && <p className="error-text">{error}</p>}
      </MenuPopover>
    </>
  )
}

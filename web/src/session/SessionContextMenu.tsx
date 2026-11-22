import { useCallback, useRef, useState } from 'react'
import type { MouseEvent, ReactElement } from 'react'

import { describeError } from '../api/errors'
import { sessions as sessionAPI } from '../api/endpoints'
import { childEnded } from '../api/types'
import { useArmedConfirm } from '../hooks/useArmedConfirm'
import { MenuPopover } from '../ui/MenuPopover'
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
// opens. One entry queues a fresh follow-up session behind this one, landing
// the workspace provider's queue draft on the shared form shells; an optional
// rename entry covers surfaces without an inline pencil (mobile rows); the
// armed stop is the same guard the cards' stop buttons carry.
export function SessionContextMenu({
  menu,
  onClose,
  onRename,
}: {
  menu: SessionMenuPoint | null
  onClose: () => void
  onRename?: () => void
}): ReactElement | null {
  if (menu === null) return null
  return <MenuBody key={menu.epoch} menu={menu} onClose={onClose} onRename={onRename} />
}

function MenuBody({
  menu,
  onClose,
  onRename,
}: {
  menu: SessionMenuPoint
  onClose: () => void
  onRename?: () => void
}): ReactElement {
  const { sessions } = useSwarm()
  const { setQueueDraft } = useWorkspace()
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
      <MenuPopover anchorRef={anchorRef} className="menu card" role="menu" onClose={onClose}>
        {/* the portal bubbles clicks through the React tree into the row that
            opened the menu, every item stands that leak down */}
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
        {!ended && (
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

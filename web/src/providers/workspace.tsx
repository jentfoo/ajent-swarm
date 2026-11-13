import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'

import { fleet } from '../api/endpoints'
import type { AttentionAck } from '../api/types'
import { useSessionNamer } from '../session/useSessionLabel'
import { useSwarm } from './swarm'
import { createNotificationBridge } from './notifications'
import type { NotificationPermission } from './notifications'
import { useLayoutProfile } from '../workspace/layoutProfile'
import type { LayoutProfile, TileLayout, WorkspaceMode } from '../workspace/layoutProfile'
import { ackBodyFor, deriveItem, rankAttention } from '../workspace/attention'
import type { AttentionItem } from '../workspace/attention'

interface WorkspaceContextValue {
  profile: LayoutProfile
  setMode: (mode: WorkspaceMode) => void
  selectFocusedSession: (sessionId: string | undefined) => void
  setTileLayout: (tile: TileLayout) => void

  // One derived attention model, consumed by both modes and the badge.
  needs: AttentionItem[] // dialogs and unreviewed completions by oldest wait
  waiting: AttentionItem[] // idle agents waiting for their next prompt
  working: AttentionItem[]
  needsInputCount: number
  itemFor(sessionId: string): AttentionItem | undefined

  // Acknowledgments by acting or explicit check-off. Either way the ledger is
  // server state: one POST settles every device, this one on the refresh that
  // follows.
  acknowledgeDialog: (sessionId: string, dialogId: number) => void
  acknowledgeTurn: (sessionId: string, turnEnd: number) => void
  acknowledgeItem: (item: AttentionItem) => void

  // Desktop notifications, permission gated.
  notificationPermission: NotificationPermission
  requestNotifications: () => void
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

// WorkspaceProvider carries the layout profile (mode plus each mode's state,
// persisted per browser) and the one derived attention model every surface
// consumes: the focus rail, tile badges, the title bar count and the desktop
// notification bridge.
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { attention, refreshAttention } = useSwarm()
  const { profile, setMode, selectFocusedSession, setTileLayout } = useLayoutProfile()
  const nameFor = useSessionNamer()
  const navigate = useNavigate()
  const [bridge] = useState(() => createNotificationBridge())
  const [permission, setPermission] = useState(bridge.permission())

  const items = useMemo(() => attention.map(deriveItem), [attention])
  const ranked = useMemo(() => rankAttention(items), [items])

  const itemFor = useCallback(
    (sessionId: string) => items.find((i) => i.sessionId === sessionId),
    [items],
  )

  // the ack lands server-side, then the digest re-reads so this device's rows
  // settle immediately too, a failed POST leaves the row raised, and the next
  // check-off is the retry
  const acknowledge = useCallback(
    (body: AttentionAck) => {
      void fleet
        .ackAttention(body)
        .then(refreshAttention)
        .catch(() => {})
    },
    [refreshAttention],
  )

  const acknowledgeDialog = useCallback(
    (sessionId: string, dialogId: number) => {
      // twin instances share a session id and each holds its own dialogs, so
      // the digest row carrying this one names the pid; while the digest lags
      // behind the answer the session's first row stands in
      const rows = attention.filter((row) => row.sessionId === sessionId)
      const pid = (rows.find((row) => row.dialogId === dialogId) ?? rows[0])?.pid
      acknowledge({ sessionId, pid, dialogId })
    },
    [attention, acknowledge],
  )

  const acknowledgeTurn = useCallback(
    (sessionId: string, turnEnd: number) => acknowledge({ sessionId, turnEnd }),
    [acknowledge],
  )

  const acknowledgeItem = useCallback(
    (item: AttentionItem) => {
      const body = ackBodyFor(item)
      if (body !== undefined) acknowledge(body)
    },
    [acknowledge],
  )

  const requestNotifications = useCallback(() => {
    void bridge
      .ensurePermission()
      .then(() => setPermission(bridge.permission()))
      .catch(() => {})
  }, [bridge])

  // The title bar badge and the notification bridge consume the same model:
  // the needs-input count is the single source for "something wants you".
  useEffect(() => {
    document.title =
      ranked.needsInputCount > 0 ? `(${ranked.needsInputCount}) ajent-swarm` : 'ajent-swarm'
  }, [ranked.needsInputCount])

  // Notification clicks arrive from the OS tray, outside React's flow: focus
  // the window, then navigate, both shells route /s/:sessionId.
  const openSession = useCallback(
    (sessionId: string) => {
      window.focus()
      navigate(`/s/${encodeURIComponent(sessionId)}`)
    },
    [navigate],
  )

  useEffect(
    () => bridge.publish(ranked.needs, { nameFor, openSession }),
    [bridge, ranked.needs, nameFor, openSession],
  )

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') bridge.dismissAll()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [bridge])

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      profile,
      setMode,
      selectFocusedSession,
      setTileLayout,
      needs: ranked.needs,
      waiting: ranked.waiting,
      working: ranked.working,
      needsInputCount: ranked.needsInputCount,
      itemFor,
      acknowledgeDialog,
      acknowledgeTurn,
      acknowledgeItem,
      notificationPermission: permission,
      requestNotifications,
    }),
    [
      profile,
      setMode,
      selectFocusedSession,
      setTileLayout,
      ranked,
      itemFor,
      acknowledgeDialog,
      acknowledgeTurn,
      acknowledgeItem,
      permission,
      requestNotifications,
    ],
  )

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error('useWorkspace outside WorkspaceProvider')
  return ctx
}

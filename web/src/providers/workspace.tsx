import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { useSwarm } from './swarm'
import { createNotificationBridge } from './notifications'
import type { NotificationBridge } from './notifications'
import { useLayoutProfile } from '../workspace/layoutProfile'
import type { LayoutProfile, TileLayout, WorkspaceMode } from '../workspace/layoutProfile'
import {
  ackDialog,
  ackTurn,
  deriveItem,
  rankAttention,
  subscribeLedger,
  ledgerVersionNow,
} from '../workspace/attention'
import type { AttentionItem } from '../workspace/attention'

interface WorkspaceContextValue {
  profile: LayoutProfile
  setMode: (mode: WorkspaceMode) => void
  selectInboxSession: (sessionId: string | undefined) => void
  setTileLayout: (tile: TileLayout) => void

  // One derived attention model, consumed by both modes and the badge.
  needs: AttentionItem[] // dialogs by oldest wait, then unreviewed newest first
  awaiting: AttentionItem[] // idle agents waiting for their next prompt
  working: AttentionItem[]
  needsInputCount: number
  itemFor(sessionId: string): AttentionItem | undefined

  // Acknowledgments by acting or explicit check-off.
  acknowledgeDialog: (sessionId: string, dialogId: number) => void
  acknowledgeTurn: (sessionId: string, turnEnd: number) => void
  acknowledgeItem: (item: AttentionItem) => void

  // Desktop notifications, permission gated.
  notificationPermission: NotificationBridge['permission']
  requestNotifications: () => void
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

// WorkspaceProvider carries the layout profile (mode plus each mode's state,
// persisted per browser) and the one derived attention model every surface
// consumes: the inbox rail, tile badges, the title bar count and the desktop
// notification bridge.
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { attention } = useSwarm()
  const { profile, setMode, selectInboxSession, setTileLayout } = useLayoutProfile()
  const [bridge] = useState(() => createNotificationBridge())
  const [permission, setPermission] = useState(bridge.permission())
  const [ledgerVersion, setLedgerVersion] = useState(ledgerVersionNow)

  useEffect(() => subscribeLedger(() => setLedgerVersion(ledgerVersionNow())), [])

  const items = useMemo(() => {
    void ledgerVersion // acknowledgments change the derivation, not attention
    return attention.map(deriveItem)
  }, [attention, ledgerVersion])
  const ranked = useMemo(() => rankAttention(items), [items])

  const itemFor = useCallback(
    (sessionId: string) => items.find((i) => i.sessionId === sessionId),
    [items],
  )

  const acknowledgeDialog = useCallback(
    (sessionId: string, dialogId: number) => {
      const pid = attention.find((row) => row.sessionId === sessionId)?.pid ?? 0
      ackDialog(sessionId, pid, dialogId)
    },
    [attention],
  )

  const acknowledgeTurn = useCallback((sessionId: string, turnEnd: number) => {
    ackTurn(sessionId, turnEnd)
  }, [])

  const acknowledgeItem = useCallback((item: AttentionItem) => {
    if (item.kind === 'needs-input' && item.dialogId !== undefined) {
      ackDialog(item.sessionId, item.pid, item.dialogId)
      return
    }
    if (item.kind === 'needs-review' && item.turnEnd !== undefined) {
      ackTurn(item.sessionId, item.turnEnd)
    }
  }, [])

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

  useEffect(() => bridge.publish(ranked.needs), [bridge, ranked.needs])

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
      selectInboxSession,
      setTileLayout,
      needs: ranked.needs,
      awaiting: ranked.awaiting,
      working: ranked.working,
      needsInputCount: ranked.needsInputCount,
      itemFor,
      acknowledgeDialog,
      acknowledgeTurn,
      acknowledgeItem,
      notificationPermission: () => permission,
      requestNotifications,
    }),
    [
      profile,
      setMode,
      selectInboxSession,
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

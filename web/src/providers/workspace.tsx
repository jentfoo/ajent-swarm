import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'

import { chainsApi, fleet } from '../api/endpoints'
import type { AttentionAck, Chain } from '../api/types'
import { useSessionNamer } from '../session/useSessionLabel'
import { useSwarm } from './swarm'
import { createNotificationBridge } from './notifications'
import type { NotificationPermission } from './notifications'
import { useLayoutProfile } from '../workspace/layoutProfile'
import type { LayoutProfile, TileLayout, WorkspaceMode } from '../workspace/layoutProfile'
import {
  ackBodyFor,
  deriveItem,
  failedChainOf,
  noticeEligible,
  rankAttention,
} from '../workspace/attention'
import type { AttentionItem } from '../workspace/attention'

// ChainDraft opens the chain dialog: the two sessions plus, on edit, the
// record the strip prefills from.
export interface ChainDraft {
  parentId: string
  childId: string
  chain?: Chain
}

// QueueDraft opens the follow-up form: the parent exists, the child session
// launches at submit with the typed start prompt as its handoff line.
export interface QueueDraft {
  parentId: string
}

interface WorkspaceContextValue {
  profile: LayoutProfile
  setMode: (mode: WorkspaceMode) => void
  selectFocusedSession: (sessionId: string | undefined) => void
  // focus-rail pins, per browser: pinned sessions top the focused view under
  // Pinned whatever their live state
  pinnedSessionIds: string[]
  togglePinnedSession: (sessionId: string) => void
  setTileLayout: (tile: TileLayout) => void

  // The chain dialog's open state beside the chain records the workspace
  // holds: the list backs every strip's edit affordance on any device, the
  // digest's per-role chain ids name the records to load.
  chainDraft: ChainDraft | null
  setChainDraft: (draft: ChainDraft | null) => void
  queueDraft: QueueDraft | null
  setQueueDraft: (draft: QueueDraft | null) => void
  rememberChain: (chain: Chain) => void
  chainById: (id: string) => Chain | undefined
  refreshChain: (id: string) => Promise<Chain | undefined>

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
  const { profile, setMode, selectFocusedSession, togglePinnedSession, setTileLayout } =
    useLayoutProfile()
  const nameFor = useSessionNamer()
  const navigate = useNavigate()
  const [bridge] = useState(() => createNotificationBridge())
  const [permission, setPermission] = useState(bridge.permission())
  const [chainDraft, setChainDraft] = useState<ChainDraft | null>(null)
  const [queueDraft, setQueueDraft] = useState<QueueDraft | null>(null)
  const [chainRecords, setChainRecords] = useState<Map<string, Chain>>(new Map())

  const rememberChain = useCallback((chain: Chain) => {
    setChainRecords((prev) => new Map(prev).set(chain.id, chain))
  }, [])

  // chainById reads one held record, the digest's per-role chain ids name them
  const chainById = useCallback((id: string) => chainRecords.get(id), [chainRecords])

  // refreshChain re-reads one record, so an edit opens from current state
  // instead of a snapshot another device or an earlier digest may hold
  const refreshChain = useCallback(
    async (id: string): Promise<Chain | undefined> => {
      try {
        const chain = await chainsApi.get(id)
        rememberChain(chain)
        return chain
      } catch {
        return undefined
      }
    },
    [rememberChain],
  )

  const items = useMemo(() => attention.map(deriveItem), [attention])
  const ranked = useMemo(() => rankAttention(items), [items])

  // chain ids the digest currently badges, the wanted set that drives list
  // fetches: one request per new id, settled chains stop mattering once the
  // digest drops their fold
  const wantedChains = useMemo(() => {
    const ids = new Set<string>()
    for (const item of items) {
      if (item.chainedOnId !== undefined) ids.add(item.chainedOnId)
      if (item.deliveringId !== undefined) ids.add(item.deliveringId)
    }
    return ids
  }, [items])

  // ids one list fetch already covered, so an absent or failed row never
  // re-triggers the request on every digest commit
  const attemptedChains = useRef(new Set<string>())

  useEffect(() => {
    const missing: string[] = []
    for (const id of wantedChains) {
      if (!chainRecords.has(id) && !attemptedChains.current.has(id)) missing.push(id)
    }
    if (missing.length === 0) return
    for (const id of missing) attemptedChains.current.add(id)
    let alive = true
    chainsApi
      .list()
      .then((rows) => {
        if (!alive) return
        setChainRecords((prev) => {
          const next = new Map(prev)
          for (const ch of rows) next.set(ch.id, ch)
          return next
        })
      })
      .catch(() => {}) // best effort, a later wanted id refetches the list
    return () => {
      alive = false
    }
  }, [wantedChains, chainRecords])

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

  // Notice surfaces dwell-gate their raise per digest commit: the tab title
  // and the notification bridge stay quiet for dialogs younger than the
  // dwell, while the rail and in-app badges keep live counts.
  const notices = useMemo(() => ranked.needs.filter(noticeEligible), [ranked])

  // The title badge and the notification bridge consume the same gated list:
  // the needs-input count is the single source for "something wants you".
  useEffect(() => {
    const count = notices.filter((i) => i.kind === 'needs-input').length
    document.title = count > 0 ? `(${count}) ajent-swarm` : 'ajent-swarm'
  }, [notices])

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
    () => bridge.publish(notices, { nameFor, openSession }),
    [bridge, notices, nameFor, openSession],
  )

  // One failed chain announces once per failure: the digest's fresh failure
  // line is the trigger, the notice names both sessions and its click opens
  // the child, the session left without its handoff. The bridge's keyed
  // raise is the same one-shot guard the dialog notices use; it skips the
  // dialog dwell gate deliberately, a failure is terminal and cannot flap.
  const failedChains = useMemo(
    () =>
      items.flatMap((item) => {
        const failed = failedChainOf(item)
        return failed === undefined ? [] : [failed]
      }),
    [items],
  )
  useEffect(() => {
    for (const failed of failedChains) {
      bridge.raiseOnce(`chain:${failed.chainId}`, {
        title: `Chain into ${nameFor(failed.childId)} failed`,
        body: `${nameFor(failed.parentId)} → ${nameFor(failed.childId)}: ${failed.reason}`,
        tag: `chain-${failed.chainId}`,
        onclick: () => openSession(failed.childId),
      })
    }
  }, [bridge, failedChains, nameFor, openSession])

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
      pinnedSessionIds: profile.focused.pinnedSessionIds,
      togglePinnedSession,
      setTileLayout,
      chainDraft,
      setChainDraft,
      queueDraft,
      setQueueDraft,
      rememberChain,
      chainById,
      refreshChain,
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
      togglePinnedSession,
      setTileLayout,
      chainDraft,
      setChainDraft,
      queueDraft,
      setQueueDraft,
      rememberChain,
      chainById,
      refreshChain,
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

// The one client-side attention model every surface consumes: the focus rail,
// tile tab badges, the title bar count and the desktop notification bridge.
//
// Three attention kinds rise from the digest plus this ledger:
//   - needs input: open dialogs, ranked by oldest wait
//   - needs review: an idle session after a turn end not yet acknowledged
//   - awaiting: an idle agent waiting for its next prompt (the rail's Waiting
//     queue, but never badged or notified)
//
// Acknowledging happens by acting (answering the dialog, submitting a prompt)
// or an explicit check-off. The ledger persists in localStorage keyed by
// session id plus the process and the dialog or turn identifier, so reloads
// never re-raise settled items and a restarted session's dialog ids cannot
// collide with the previous run's acknowledgments.
import type { AttentionRow } from '../api/types'

export type AttentionKind = 'needs-input' | 'needs-review' | 'awaiting' | 'working'

// instanceKey names one listing row: twin instances share a session id and
// are told apart by pid, with 0 standing in for an unknown one.
export function instanceKey(sessionId: string, pid?: number): string {
  return `${sessionId}:${pid ?? 0}`
}

// isActionable marks the attention kinds a check-off can settle.
export function isActionable(kind: AttentionKind): boolean {
  return kind === 'needs-input' || kind === 'needs-review'
}

export interface AttentionItem {
  sessionId: string
  kind: AttentionKind
  reason: string // one line: the dialog prompt or the turn's stop summary
  since: number // unix ms the state started; drives waits and ranking
  pid: number
  dialogId?: number // present on needs-input rows raised by a dialog
  turnEnd?: number // present on needs-review rows
  running: boolean
  queuedAt?: number // unix ms the session entered its current queue, client-stamped
}

// --- ledger, persisted under one versioned key ---

const storageKey = 'swarm.attention.v1'

interface LedgerData {
  dialogs: Record<string, Record<string, number>> // session -> 'pid:dialog' -> acked at
  turns: Record<string, number> // session -> last acknowledged turn end
}

const maxDialogAcksPerSession = 50

function emptyLedger(): LedgerData {
  return { dialogs: {}, turns: {} }
}

function readLedger(): LedgerData {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw === null) return emptyLedger()
    const parsed = JSON.parse(raw) as Partial<LedgerData>
    return {
      dialogs: parsed.dialogs && typeof parsed.dialogs === 'object' ? parsed.dialogs : {},
      turns: parsed.turns && typeof parsed.turns === 'object' ? parsed.turns : {},
    }
  } catch {
    return emptyLedger() // corrupt storage reads as fresh
  }
}

function writeLedger(data: LedgerData): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(data))
  } catch {
    // Persisting acknowledgments is best effort.
  }
}

function dialogKey(pid: number, dialogId: number): string {
  return `${pid}:${dialogId}`
}

let ledger: LedgerData = readLedger() // one read per page load, writes keep current
const ledgerListeners = new Set<() => void>()
let ledgerVersion = 0
let storageHooked = false

// Another tab acknowledging must not re-raise rows here: the storage event
// re-reads the ledger so every open view shares one acknowledgment state.
function hookStorage(): void {
  if (storageHooked) return
  storageHooked = true
  window.addEventListener('storage', (ev) => {
    if (ev.key !== null && ev.key !== storageKey) return
    ledger = readLedger()
    ledgerVersion += 1
    for (const cb of ledgerListeners) cb()
  })
}

function mutateLedger(fn: (data: LedgerData) => void): void {
  fn(ledger)
  ledgerVersion += 1
  writeLedger(ledger)
  for (const cb of ledgerListeners) cb()
}

// subscribeLedger drives useSyncExternalStore; reading is versioned so React
// re-renders only when acknowledgments change.
export function subscribeLedger(cb: () => void): () => void {
  hookStorage()
  ledgerListeners.add(cb)
  return () => ledgerListeners.delete(cb)
}

export function ledgerVersionNow(): number {
  return ledgerVersion
}

// resetLedger clears acknowledgment state; page loads re-read storage, so
// only tests need this for isolation between cases.
export function resetLedger(): void {
  ledger = emptyLedger()
  ledgerVersion += 1
}

// ackDialog records one dialog answered or checked off.
export function ackDialog(sessionId: string, pid: number, dialogId: number): void {
  if (dialogId <= 0) return
  mutateLedger((data) => {
    const perSession = (data.dialogs[sessionId] ??= {})
    perSession[dialogKey(pid, dialogId)] = Date.now()
    // Bound growth: drop the oldest acknowledgments once a session stacks up.
    const keys = Object.keys(perSession)
    if (keys.length > maxDialogAcksPerSession) {
      keys
        .sort((a, b) => (perSession[a] ?? 0) - (perSession[b] ?? 0))
        .slice(0, keys.length - maxDialogAcksPerSession)
        .forEach((k) => delete perSession[k])
    }
  })
}

// ackTurn records one turn reviewed; acting later than an older turn end
// covers it too, so the stored value only ever moves forward.
export function ackTurn(sessionId: string, turnEnd: number): void {
  if (turnEnd <= 0) return
  if ((ledger.turns[sessionId] ?? 0) >= turnEnd) return
  mutateLedger((data) => {
    data.turns[sessionId] = Math.max(data.turns[sessionId] ?? 0, turnEnd)
  })
}

export function isDialogAcked(sessionId: string, pid: number, dialogId: number): boolean {
  return ledger.dialogs[sessionId]?.[dialogKey(pid, dialogId)] !== undefined
}

export function ackedTurn(sessionId: string): number {
  return ledger.turns[sessionId] ?? 0
}

// --- derivation ---

// deriveItem folds one digest row and the ledger into the session's current
// attention: needs input beats needs review, then an idle agent is awaiting
// its next prompt, and only busy sessions are working. The digest names only
// the oldest open dialog, so a session with that one acknowledged still shows
// a generic count while further dialogs wait.
export function deriveItem(row: AttentionRow): AttentionItem {
  const pid = row.pid ?? 0
  const busy = row.running || row.spinning === true
  const base = {
    sessionId: row.sessionId,
    pid,
    running: busy,
  }

  const dialogOpen = row.openInteractions > 0
  if (dialogOpen) {
    const oldestAcked = isDialogAcked(row.sessionId, pid, row.dialogId ?? 0)
    const unacked = row.openInteractions - (oldestAcked ? 1 : 0)
    if (unacked > 0) {
      return {
        ...base,
        kind: 'needs-input',
        reason:
          oldestAcked || !row.dialogPrompt?.trim()
            ? `${unacked} more dialog(s) open`
            : row.dialogPrompt.trim(),
        since: row.dialogAt ?? 0,
        dialogId: row.dialogId,
      }
    }
  }

  const turnEnd = row.lastTurnEnd ?? 0
  if (!busy && turnEnd > 0 && turnEnd > ackedTurn(row.sessionId)) {
    return {
      ...base,
      kind: 'needs-review',
      reason: describeStop(row.lastStop, row.lastStopErr),
      since: turnEnd,
      turnEnd,
    }
  }

  if (!busy) {
    return {
      ...base,
      kind: 'awaiting',
      reason: row.activity?.trim() || 'waiting for a prompt',
      since: 0,
    }
  }

  return {
    ...base,
    kind: 'working',
    reason: row.activity ?? '',
    since: 0,
  }
}

// --- shared ordering ---

// AttentionSort carries the facts that place an alive row. A digest item
// qualifies as-is and a listing row without one passes only its session id,
// ranking with working yet keeping stable name order.
export interface AttentionSort {
  sessionId: string
  kind?: AttentionKind // absent shares the working class below
  since?: number // dialog wait or turn end, within-class order
  queuedAt?: number // queue entry, drives movers to the end
}

// The rail renders three queues: Needs input holds every state wanting a
// human answer (dialogs and unreviewed completions together), Waiting holds
// new and settled idle agents, Working holds the busy ones. Rows badge their
// own kind, so a queue never encodes state on its own. Every surface renders
// these verbatim so desktop and mobile cannot drift.
export type AttentionQueue = 'needs' | 'waiting' | 'working'

export const attentionSectionTitles: Record<AttentionQueue, string> = {
  needs: 'Needs input',
  waiting: 'Waiting',
  working: 'Working',
}

// Queue ranks in rail order: needs, waiting, working.
export const attentionRanks = {
  needs: 0,
  waiting: 1,
  working: 2,
} as const

// attentionRank classifies one row into its queue rank: dialogs and
// completions collapse into needs, idle agents wait, and rows without a
// digest share working so they never outrank actionable ones.
export function attentionRank(entry: AttentionSort): number {
  switch (entry.kind) {
    case 'needs-input':
    case 'needs-review':
      return attentionRanks.needs
    case 'awaiting':
      return attentionRanks.waiting
    default:
      return attentionRanks.working
  }
}

// attentionQueue buckets one row into the rail's three queues.
export function attentionQueue(entry: AttentionSort): AttentionQueue {
  const rank = attentionRank(entry)
  if (rank === attentionRanks.needs) return 'needs'
  if (rank === attentionRanks.waiting) return 'waiting'
  return 'working'
}

// compareAttention orders two rows the way rankAttention renders them: queue
// first, then needs rows by oldest wait (dialogs and completions share one
// order), waiting and working by queue entry so a row moving between queues
// lands at the end of its new one. Everything else stable by session id.
// Every surface sorting alive rows consumes it.
export function compareAttention(a: AttentionSort, b: AttentionSort): number {
  const ra = attentionRank(a)
  const rb = attentionRank(b)
  if (ra !== rb) return ra - rb
  if (ra === attentionRanks.needs) {
    return (a.since ?? 0) - (b.since ?? 0) || a.sessionId.localeCompare(b.sessionId)
  }
  return (a.queuedAt ?? 0) - (b.queuedAt ?? 0) || a.sessionId.localeCompare(b.sessionId)
}

// --- queue entries, in memory only ---

// The digest carries no timestamp for idle or busy transitions, so each
// session's arrival in its current queue is stamped client-side: one map,
// re-stamped only when the kind changes, pruned when the session leaves.
// Reloads re-stamp; settled order is cosmetic and never persisted.
const queueEntries = new Map<string, { kind: AttentionKind; at: number }>()

// queueKey pairs queue entries by instance.
function queueKey(item: Pick<AttentionItem, 'sessionId' | 'pid'>): string {
  return instanceKey(item.sessionId, item.pid)
}

// stampQueueEntries pairs every item with its queue entry time, stamping
// arrivals and kind changes at one shared clock read so a fresh batch stays
// name-stable, and drops entries for sessions no longer present.
function stampQueueEntries(items: readonly AttentionItem[]): AttentionItem[] {
  const now = Date.now()
  const stamped = items.map((item) => {
    const key = queueKey(item)
    const entry = queueEntries.get(key)
    if (entry === undefined || entry.kind !== item.kind) {
      queueEntries.set(key, { kind: item.kind, at: now })
      return { ...item, queuedAt: now }
    }
    return { ...item, queuedAt: entry.at }
  })
  const live = new Set(stamped.map(queueKey))
  for (const key of queueEntries.keys()) {
    if (!live.has(key)) queueEntries.delete(key)
  }
  return stamped
}

// resetQueueEntries clears arrival stamps; only tests need this for
// isolation between cases.
export function resetQueueEntries(): void {
  queueEntries.clear()
}

// rankAttention buckets the rail's queues: needs holds dialogs and unreviewed
// completions together by oldest wait, waiting (new and settled idle agents)
// and working follow by queue entry so movers append. needsInputCount counts
// open dialogs only.
export function rankAttention(items: readonly AttentionItem[]): {
  needs: AttentionItem[]
  waiting: AttentionItem[]
  working: AttentionItem[]
  needsInputCount: number
} {
  const stamped = stampQueueEntries(items)
  return {
    needs: stamped.filter((i) => attentionQueue(i) === 'needs').sort(compareAttention),
    waiting: stamped.filter((i) => attentionQueue(i) === 'waiting').sort(compareAttention),
    working: stamped.filter((i) => attentionQueue(i) === 'working').sort(compareAttention),
    needsInputCount: stamped.filter((i) => i.kind === 'needs-input').length,
  }
}

// acknowledgeItem is the explicit check-off: acting is preferred, but a row
// can always be silenced by hand.
export function acknowledgeItem(item: AttentionItem): void {
  if (item.kind === 'needs-input' && item.dialogId !== undefined) {
    ackDialog(item.sessionId, item.pid, item.dialogId)
    return
  }
  if (item.kind === 'needs-review' && item.turnEnd !== undefined) {
    ackTurn(item.sessionId, item.turnEnd)
  }
}

// attendBadgeLabels is the copy every shell's rising-attention count badge
// shares, so the surfaces never drift apart.
export function attendBadgeLabels(count: number): { title: string; ariaLabel: string } {
  return {
    title: `${count} session(s) need input`,
    ariaLabel: `${count} sessions need input`,
  }
}

// describeStop turns a turn end into the row's one-line summary.
export function describeStop(stop: string | undefined, err: string | undefined): string {
  if (err) return 'turn failed'
  switch (stop) {
    case 'end_turn':
      return 'turn complete'
    case 'max_tokens':
      return 'stopped: max tokens'
    case 'aborted':
      return 'turn interrupted'
    case 'tool_use':
    case 'incomplete':
      return 'turn paused unfinished'
    case 'error':
      return 'turn failed'
    case undefined:
    case '':
    case 'unknown':
      return 'turn finished'
    default:
      return `stopped: ${stop}`
  }
}

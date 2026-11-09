// The one client-side attention model every surface consumes: the focus rail,
// tile tab badges, the title bar count and the desktop notification bridge.
//
// The kind, reason and wait of a row arrive derived on the /api/attention
// digest, folded there against the server-side acknowledgment ledger, so every
// device renders one attention state. Acknowledging happens by acting
// (answering the dialog, submitting a prompt) or an explicit check-off; either
// way it lands as POST /api/attention/ack and the settled row reads back on
// the next digest poll.
//
// Queue-entry stamping stays client-side: arrival order in a queue is cosmetic
// per-view state the server never sees.
import type { AttentionAck, AttentionKind, AttentionRow } from '../api/types'
import { sessionBusy } from '../state/eventApplier'

export type { AttentionKind } from '../api/types'

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
  turnEnd?: number // present on needs-review rows; the ack watermark target
  running: boolean
  queuedAt?: number // unix ms the session entered its current queue, client-stamped
}

// deriveItem maps one digest row onto the shared item shape. The kind, reason
// and wait render verbatim from the server's derivation; only the busy fact
// folds locally so badges can lead the digest by one snapshot.
export function deriveItem(row: AttentionRow): AttentionItem {
  return {
    sessionId: row.sessionId,
    kind: row.kind,
    reason: row.reason ?? '',
    since: row.since ?? 0,
    pid: row.pid ?? 0,
    dialogId: row.dialogId,
    turnEnd: row.kind === 'needs-review' ? row.lastTurnEnd : undefined,
    running: sessionBusy(row),
  }
}

// ackBodyFor names what one explicit check-off settles: a dialog by pid, or
// the session's turn-end watermark. Nothing else is actionable.
export function ackBodyFor(item: AttentionItem): AttentionAck | undefined {
  if (item.kind === 'needs-input' && item.dialogId !== undefined) {
    return { sessionId: item.sessionId, pid: item.pid, dialogId: item.dialogId }
  }
  if (item.kind === 'needs-review' && item.turnEnd !== undefined) {
    return { sessionId: item.sessionId, turnEnd: item.turnEnd }
  }
  return undefined
}

// --- badge states ---

// SessionBadge is one live session's at-a-glance badge state. The switcher
// rows render it directly; the session headers fold waiting into idle.
export type SessionBadge = 'input' | 'running' | 'waiting' | 'idle'

// sessionBadgeOf ranks one session's badge state from its own busy fact plus
// the shared attention item. A pending dialog parks the turn upstream, so
// needs-input outranks running: the run is blocked on this human, not making
// progress.
export function sessionBadgeOf(busy: boolean, item: AttentionItem | undefined): SessionBadge {
  if (item?.kind === 'needs-input') return 'input'
  if (busy || (item?.running ?? false)) return 'running'
  if (item?.kind === 'awaiting') return 'waiting'
  return 'idle'
}

// HeaderBadge is the session headers' badge state: working, resting, or
// blocked on a human.
export type HeaderBadge = 'input' | 'running' | 'idle'

// headerBadgeOf is the headers' coarsening of sessionBadgeOf: waiting folds
// into idle, since the header answers working-versus-resting while the status
// line under the transcript explains a resting agent.
export function headerBadgeOf(busy: boolean, item: AttentionItem | undefined): HeaderBadge {
  const badge = sessionBadgeOf(busy, item)
  return badge === 'waiting' ? 'idle' : badge
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

// attentionKindLabels is the human vocabulary for one attention kind: the
// phrase badges announce for assistive tech, never the wire token. Every
// spoken surface reads from here so copy cannot drift.
export const attentionKindLabels: Record<AttentionKind, string> = {
  'needs-input': 'needs input',
  'needs-review': 'needs review',
  awaiting: 'waiting',
  working: 'working',
}

// attendBadgeLabels is the copy every shell's rising-attention count badge
// shares, so the surfaces never drift apart. Keys spread straight onto DOM,
// so aria keeps its attribute spelling.
export function attendBadgeLabels(count: number): { title: string; 'aria-label': string } {
  return {
    title: `${count} session(s) need input`,
    'aria-label': `${count} sessions need input`,
  }
}

// describeStop turns a turn end into the listing card's one-line summary.
// Mirrors stopReasonText in pkg/fleet/attention.go, which derives the digest's
// needs-review reason; keep them in step.
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

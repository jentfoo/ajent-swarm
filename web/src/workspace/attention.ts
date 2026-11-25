// The one client-side attention model every surface consumes: the focus rail,
// tile tab badges, the tab title's gated count and the desktop notification
// bridge.
//
// The kind, reason and wait of a row arrive derived on the /api/attention
// digest, folded there against the server-side acknowledgment ledger, so every
// device renders one attention state. Acknowledging happens by acting
// (answering the dialog, submitting a prompt) or an explicit check-off, either
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
  parked: boolean // a prompt waits in swarm for the session's next idle point
  // chain facts verbatim from the digest, ids only: one id per role so a
  // session chained in both directions keeps both links addressable
  chainedOn?: string // a live chain delivers into this session: the parent id
  chainedOnId?: string // that link's chain id
  deliveringTo?: string // a live chain this session feeds: the child id
  deliveringId?: string // that link's chain id
  chainFailure?: string // fresh failure cause, both endpoints carry it
  queuedAt?: number // unix ms the session entered its current queue, client-stamped
}

// deriveItem maps one digest row onto the shared item shape. The kind, reason
// and wait render verbatim from the server's derivation, only the busy fact
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
    parked: (row.parked ?? 0) > 0,
    chainedOn: row.chainedOn,
    chainedOnId: row.chainedOnId,
    deliveringTo: row.deliveringTo,
    deliveringId: row.deliveringId,
    chainFailure: row.chainFailure,
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

// submitTurnEnd stamps the submit path's turn ack: the review row's server
// turn end, so a client clock skewed ahead of the host cannot over-settle a
// future turn. Without a row the local clock stands in.
export function submitTurnEnd(item: AttentionItem | undefined): number {
  return item?.turnEnd ?? Date.now()
}

// --- notice dwell ---

// Notice surfaces (the tab title and desktop notifications) wait out this
// dwell before raising a dialog, so prompts auto-resolved within seconds
// never announce. Age reads the server's since stamp and only grows, so a
// raised dialog stays raised until it settles or is acknowledged.
export const noticeDwellMs = 5_000

// noticeEligible gates one item's raise, evaluated per digest commit. Kinds
// other than needs-input always pass, in-app surfaces stay unfiltered.
export function noticeEligible(item: AttentionItem): boolean {
  if (item.kind !== 'needs-input') return true
  return Date.now() - (item.since ?? 0) >= noticeDwellMs
}

// --- chain failure notices ---

// FailedChain names one freshly failed chain the digest surfaces on either
// endpoint's row: both endpoints' ids and the failure cause.
export interface FailedChain {
  chainId: string
  childId: string
  parentId: string
  reason: string
}

// failedChainOf reads one digest item as a failed chain, undefined while the
// row carries no fresh failure. The child row names the parent link, the
// parent row the child one, so an exited child still surfaces its failure.
export function failedChainOf(item: AttentionItem): FailedChain | undefined {
  if (item.chainFailure === undefined) return undefined
  if (item.chainedOnId !== undefined && item.chainedOn !== undefined) {
    return {
      chainId: item.chainedOnId,
      childId: item.sessionId,
      parentId: item.chainedOn,
      reason: item.chainFailure,
    }
  }
  if (item.deliveringId !== undefined && item.deliveringTo !== undefined) {
    return {
      chainId: item.deliveringId,
      childId: item.deliveringTo,
      parentId: item.sessionId,
      reason: item.chainFailure,
    }
  }
  return undefined
}

// chainNoticeOf names one item's chain role for the rail and switcher lines:
// a fresh failure leads, then the inbound link reads as queued behind and the
// outbound as handing off. The caller's namer resolves the endpoint, so the
// copy agrees across surfaces.
export function chainNoticeOf(
  item: AttentionItem,
  nameFor: (sessionId: string) => string,
): string | undefined {
  if (item.chainFailure !== undefined) return `chain failed: ${item.chainFailure}`
  if (item.chainedOn !== undefined) return `queued behind ${nameFor(item.chainedOn)}`
  if (item.deliveringTo !== undefined) return `handing off to ${nameFor(item.deliveringTo)}`
  return undefined
}

// --- badge states ---

// SessionBadge is one live session's at-a-glance badge state. The switcher
// rows render it directly, the session headers fold waiting into idle.
export type SessionBadge =
  'input' | 'running' | 'queued' | 'chained' | 'failed' | 'review' | 'waiting' | 'idle'

// sessionBadgeOf ranks one session's badge state from its own busy fact plus
// the shared attention item. A pending dialog parks the turn upstream, so
// needs-input outranks running: the run is blocked on this human, not making
// progress. A parked prompt outranks a live turn: the queue outlives the turn
// and stays pending until the idle point, while the row itself sits in
// Working through the digest kind. A fresh chain failure outranks the chain's
// own wait and ordinary running: the sequence stopped and names its cause. An
// unreviewed turn end badges review once
// the run goes quiet, matching the rail's kind badge, while a locally busy
// snapshot still leads a stale digest. A chained wait outranks plain waiting:
// the session holds work queued behind another one.
export function sessionBadgeOf(busy: boolean, item: AttentionItem | undefined): SessionBadge {
  if (item?.kind === 'needs-input') return 'input'
  if (item?.chainFailure !== undefined) return 'failed'
  if (item?.parked) return 'queued'
  if (busy || (item?.running ?? false)) return 'running'
  if (item?.kind === 'needs-review') return 'review'
  if (item?.chainedOn !== undefined || item?.deliveringTo !== undefined) return 'chained'
  if (item?.kind === 'awaiting') return 'waiting'
  return 'idle'
}

// HeaderBadge is the session headers' badge state: working, resting, queued
// for the next idle point, chained onto another session, a failed chain,
// blocked on a human, or holding an unreviewed turn.
type HeaderBadge = 'input' | 'running' | 'queued' | 'chained' | 'failed' | 'review' | 'idle'

// headerBadgeOf is the headers' coarsening of sessionBadgeOf: waiting folds
// into idle, since the header answers working-versus-resting while the status
// line under the transcript explains a resting agent. Review, queued and a
// failed chain stay visible, they explain the wait or its loss itself.
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
  chainedOn?: string // the session this one waits behind, from the chain fold
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
const attentionRanks = {
  needs: 0,
  waiting: 1,
  working: 2,
} as const

// attentionRank classifies one row into its queue rank: dialogs and
// completions collapse into needs, idle agents wait, and rows without a
// digest share working so they never outrank actionable ones. A session
// chained behind another ranks working regardless: it holds queued chain
// work, the same class a parked prompt waits in.
function attentionRank(entry: AttentionSort): number {
  switch (entry.kind) {
    case 'needs-input':
    case 'needs-review':
      return attentionRanks.needs
    case 'awaiting':
      return entry.chainedOn !== undefined ? attentionRanks.working : attentionRanks.waiting
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
// Reloads re-stamp, settled order is cosmetic and never persisted.
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

// resetQueueEntries clears arrival stamps, only tests need this for
// isolation between cases.
export function resetQueueEntries(): void {
  queueEntries.clear()
}

// rankAttention buckets the rail's queues: needs holds dialogs and unreviewed
// completions together by oldest wait, waiting (new and settled idle agents)
// and working follow by queue entry so movers append. Chained sessions anchor
// directly below the session they wait behind within Working. needsInputCount
// counts open dialogs only.
export function rankAttention(items: readonly AttentionItem[]): {
  needs: AttentionItem[]
  waiting: AttentionItem[]
  working: AttentionItem[]
  needsInputCount: number
} {
  const stamped = stampQueueEntries(items)
  const buckets: Record<AttentionQueue, AttentionItem[]> = { needs: [], waiting: [], working: [] }
  let needsInputCount = 0
  for (const item of stamped) {
    if (item.kind === 'needs-input') needsInputCount += 1
    buckets[attentionQueue(item)].push(item)
  }
  buckets.needs.sort(compareAttention)
  buckets.waiting.sort(compareAttention)
  buckets.working.sort(compareAttention)
  buckets.working = anchorChained(buckets.working)
  return { ...buckets, needsInputCount }
}

// anchorChained reorders one queue so each chained session sits directly
// below the session it waits behind, when that parent shares the queue;
// chains run deep, so a child anchors below its parent after the parent
// itself anchored. Every other row keeps its ranked order, and a chain whose
// parent sits in another queue stays put.
export function anchorChained<T extends { sessionId: string; chainedOn?: string }>(
  rows: readonly T[],
): T[] {
  const present = new Set(rows.map((row) => row.sessionId))
  const children = new Map<string, T[]>() // parent id -> waiting rows, ranked order
  const free: T[] = []
  for (const row of rows) {
    if (row.chainedOn !== undefined && present.has(row.chainedOn)) {
      const list = children.get(row.chainedOn) ?? []
      list.push(row)
      children.set(row.chainedOn, list)
    } else {
      free.push(row)
    }
  }
  const out: T[] = []
  const emitted = new Set<string>()
  const emit = (row: T) => {
    if (emitted.has(row.sessionId)) return
    emitted.add(row.sessionId)
    out.push(row)
    for (const kid of children.get(row.sessionId) ?? []) emit(kid)
  }
  for (const row of free) emit(row)
  for (const row of rows) emit(row) // unreachable rows keep their ranked order
  return out
}

// attentionKindLabels is the human vocabulary for one attention kind: the
// phrase tile tab badges announce for assistive tech, never the wire token.
// The rail renders terser badge copy of its own.
export const attentionKindLabels: Record<AttentionKind, string> = {
  'needs-input': 'needs input',
  'needs-review': 'needs review',
  awaiting: 'waiting',
  working: 'working',
}

// attendBadgePath is the /s/ route one count badge activation opens: the
// first dialog of the caller's ranked needs queue, encoded for the path.
// Undefined when only reviews wait, so callers keep their existing destination.
export function attendBadgePath(needs: readonly AttentionItem[]): string | undefined {
  const first = needs.find((item) => item.kind === 'needs-input')
  return first === undefined ? undefined : `/s/${encodeURIComponent(first.sessionId)}`
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
// needs-review reason, keep them in step.
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

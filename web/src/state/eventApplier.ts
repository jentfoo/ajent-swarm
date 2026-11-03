// Pure reducer applying /api/stream frames to one session's view state,
// transcribing control-api.md's reconciliation contract in one place:
//
//   - an init replaces everything and resets the watermark
//   - events apply only above the watermark (ephemeral) and dedupe by entry
//     id (committed)
//   - keyed families replace wholesale, empty text removes a row
//   - dialogs are state: rebuilt from snapshots, cleared when absent
//   - queue rows resolve by id, secret redaction respected
//
// The reducer returns new top-level state objects per action, while the entry
// map and child index mutate in place. Every mutating operation is idempotent
// under replay (dedupe by entry id), so React's double invocation converges.
import type {
  CtlState,
  Entry,
  InitFrame,
  InteractionPending,
  QueueRow,
  ToolState,
  WireEvent,
} from '../api/types'

export interface DiffView {
  path: string
  before: string
  after: string
}

export interface ToolProgressView {
  name?: string
  path?: string
  bytes?: number
  lines?: number
  done?: boolean
}

export interface ToolCallView {
  id: string
  name: string
  input?: unknown
  progress?: ToolProgressView
  outputs: string[] // streamed deltas painted so far; result.output adds nothing when set
  result?: { output: string; error: boolean; fault?: string }
  closed?: boolean // turn ended before a result arrived; never shows "running"
}

// LiveTurn buffers one in-flight turn's stream. Tolerant ordering holds:
// progress may precede start, a result may arrive without a start, and
// turn.end after a lost turn.start is fine.
export interface LiveTurn {
  model: string
  thinking: string
  thinkingOpen: boolean
  text: string
  textOpen: boolean
  tools: ToolCallView[] // first-seen order, keyed by id
}

export interface NoticeView {
  key: string // '' for unkeyed notices, which stack instead of replacing
  text: string
  level: 'info' | 'warn' | 'error'
  at: number // wall clock of arrival; rendering expires stale lines
}

export interface PrintCard {
  id: number
  markdown: string
}

export type PendingState = 'pending' | 'queued' | 'committed' | 'failed' | 'dropped'

// PendingSubmit is one optimistic prompt row, resolved by queue events or the
// committed entry's queueIds, never by text.
export interface PendingSubmit {
  id: string
  text: string
  state: PendingState
}

// DroppedQueueRow is one queued prompt a removal cleared, kept briefly so
// the chips can badge why it left: interrupt, rewind or recalled.
export interface DroppedQueueRow {
  id: string
  text: string
  cause?: string
}

// DialogOutcome is the real result of a dialog answered elsewhere. Free-text
// answers never echo on the wire, so text outcomes carry no body.
export interface DialogOutcome {
  id: number
  answered: boolean
  cancelled: boolean
  index?: number
  indexes?: number[]
}

// ChainInfo describes the visible transcript branch: ids oldest first,
// whether the parent walk reached a transcript root, and the id to page from.
export interface ChainInfo {
  ids: string[]
  rooted: boolean // false means older history exists beyond what we hold
  oldestId: string // '' when empty; paging uses it as its before cursor
}

export interface AppliedSessionState {
  seq: number // last applied event number, everything at or below is dropped

  snapshot: CtlState // event-driven fields; poll-only ones merge via resnapshot
  entries: Map<string, Entry> // every entry received so far, by id
  childIndex: Map<string, string[]> // parent id ('' = root) to child ids in arrival order
  chain: ChainInfo

  live: LiveTurn | null
  notices: NoticeView[]
  prints: PrintCard[]
  diffs: DiffView[] // newest last, bounded
  pendings: PendingSubmit[]
  droppedRows: DroppedQueueRow[] // recent queue.dropped rows, badged with their cause
  resolvedElsewhere: DialogOutcome[] // dialogs settled without this viewer's answer
  ownDialogs: Set<number> // dialog ids this client answered; suppresses the outcome card

  exitReason?: string // set once session.exit applies; the run ended cleanly

  lastTurnEndAt: number // wall clock of the last applied turn.end; drives resnapshot
  healTick: number // bumped when a branch change left the chain incomplete
}

export type ApplierAction =
  | { type: 'init'; frame: InitFrame }
  | { type: 'event'; event: WireEvent }
  | { type: 'snapshot'; state: CtlState }
  | { type: 'backfill'; entries: Entry[] }
  | { type: 'pendingSubmitted'; pendingId: string; text: string }
  | { type: 'pendingFailed'; pendingId: string }
  | { type: 'dialogAnswered'; dialogId: number }
  | { type: 'outcomeDismissed'; dialogId: number }

// Bounds keeping the ephemeral surfaces finite across long sessions.
const maxNotices = 50
const maxPrints = 20
const maxDiffs = 10
const maxPendings = 100
const maxDroppedRows = 20
const maxOutcomes = 5

export function initialSessionState(): AppliedSessionState {
  return {
    seq: 0,
    snapshot: emptyCtlState(),
    entries: new Map(),
    childIndex: new Map(),
    chain: { ids: [], rooted: true, oldestId: '' },
    live: null,
    notices: [],
    prints: [],
    diffs: [],
    pendings: [],
    droppedRows: [],
    resolvedElsewhere: [],
    ownDialogs: new Set(),
    lastTurnEndAt: 0,
    healTick: 0,
  }
}

function emptyCtlState(): CtlState {
  return {
    session: { id: '' },
    workspace: '',
    cwd: '',
    head: '',
    model: {
      key: '',
      short: '',
      window: 0,
      caps: { reasoning: false, images: false, parallelToolCalls: false },
    },
    permission: '',
    usage: { turns: 0, total: zeroUsage(), child: zeroUsage(), estimatedTurns: 0 },
    context: { used: 0, window: 0, reserve: 0, compact: 0, estimated: false },
    running: false,
    idle: true,
    spinning: false,
    queued: 0,
    seat: { held: false, yours: false },
  }
}

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

// --- payload decoders; malformed payloads drop rather than corrupting state ---

export interface MessageEntryData {
  message?: { role?: string; content?: unknown }
  stop?: string
  injected?: boolean
  replayed?: boolean
  origin?: string
  queueIds?: string[]
}

function decode<T>(data: unknown): T | undefined {
  if (data === undefined || data === null || typeof data !== 'object') return undefined
  return data as T
}

// --- reducer ---

export function applierReducer(
  state: AppliedSessionState,
  action: ApplierAction,
): AppliedSessionState {
  switch (action.type) {
    case 'init':
      return applyInit(state, action.frame)
    case 'event':
      return applyEvent(state, action.event)
    case 'snapshot':
      return applyResnapshot(state, action.state)
    case 'backfill': {
      const next = cloneShallow(state)
      for (const entry of action.entries) {
        if (insertEntry(next, entry)) drainLiveCoveredBy(next, entry)
      }
      recomputeChain(next)
      return next
    }
    case 'pendingSubmitted': {
      const next = cloneShallow(state)
      const row: PendingSubmit = { id: action.pendingId, text: action.text, state: 'pending' }
      next.pendings = [...state.pendings, row].slice(-maxPendings)
      return next
    }
    case 'pendingFailed': {
      // A refused submit never reached the queue; the draft stays in the composer.
      const failed = state.pendings.find((p) => p.id === action.pendingId)
      if (!failed || failed.state !== 'pending') return state
      const next = cloneShallow(state)
      next.pendings = state.pendings.map((p) =>
        p.id === action.pendingId ? { ...p, state: 'failed' as const } : p,
      )
      return next
    }
    case 'dialogAnswered': {
      // Recording our own answer keeps the settled event from painting an
      // "answered elsewhere" card for a dialog this viewer resolved.
      if (state.ownDialogs.has(action.dialogId)) return state
      const next = cloneShallow(state)
      const own = new Set(state.ownDialogs)
      own.add(action.dialogId)
      next.ownDialogs = own
      return next
    }
    case 'outcomeDismissed': {
      // Resolved chips leave on click as well as on their timer.
      if (!state.resolvedElsewhere.some((o) => o.id === action.dialogId)) return state
      const next = cloneShallow(state)
      next.resolvedElsewhere = state.resolvedElsewhere.filter((o) => o.id !== action.dialogId)
      return next
    }
  }
}

// applyInit replaces everything the client holds for the session and resets
// its watermark: ajent renumbers seq from zero on each instance, so an init
// never merges into prior state.
function applyInit(prev: AppliedSessionState, frame: InitFrame): AppliedSessionState {
  const next = initialSessionState()
  next.snapshot = frame.state
  for (const entry of frame.entries) {
    insertEntry(next, entry)
  }
  recomputeChain(next)

  // Optimistic rows survive only where the fresh authoritative state names
  // them: queued by id in the snapshot, committed via an entry's queueIds.
  const queued = new Set((frame.state.queuedRows ?? []).map((row) => row.id))
  const committed = resolveCommittedPendingIds(frame.entries)
  next.pendings = prev.pendings
    .filter((p) => queued.has(p.id) || committed.has(p.id))
    .map((p): PendingSubmit =>
      queued.has(p.id) ? { ...p, state: 'queued' } : { ...p, state: 'committed' },
    )
  return next
}

function resolveCommittedPendingIds(entries: Entry[]): Set<string> {
  const out = new Set<string>()
  for (const entry of entries) {
    if (entry.type !== 'message') continue
    for (const id of decode<MessageEntryData>(entry.data)?.queueIds ?? []) {
      out.add(id)
    }
  }
  return out
}

function applyEvent(state: AppliedSessionState, ev: WireEvent): AppliedSessionState {
  // Watermark gate first: events at or below the last applied seq are dropped.
  if (!Number.isFinite(ev.seq) || ev.seq <= state.seq) return state

  const next = cloneShallow(state)
  next.seq = ev.seq

  switch (ev.event) {
    case 'entry.append': {
      const entry = decode<{ entry?: Entry }>(ev.data)?.entry
      if (!isValidEntry(entry)) return keepSeq(state, ev.seq)
      // The head follows the committed family wherever it lands.
      next.snapshot = { ...next.snapshot, head: entry.id }
      insertEntry(next, entry)
      drainLiveCoveredBy(next, entry)
      recomputeChain(next)
      return next
    }

    case 'branch.changed': {
      const d = decode<{ head?: string }>(ev.data)
      if (!isValidId(d?.head)) return keepSeq(state, ev.seq)
      next.snapshot = { ...next.snapshot, head: d.head }
      recomputeChain(next)
      // The visible chain must follow the branch; a head whose ancestors are
      // missing locally triggers a resync or paged fetch in the channel hook.
      if (!next.chain.rooted) next.healTick += 1
      return next
    }

    case 'status':
      return applyStatus(next, ev)

    case 'activity': {
      const row = decode<{ key?: string; text?: string; rank?: number }>(ev.data)
      if (!row || !isValidId(row.key)) return keepSeq(state, ev.seq)
      const { key, text, rank } = row
      // Keyed family: non-empty text adds or replaces, empty text removes.
      const activity =
        text !== undefined && text !== ''
          ? upsertByKey(next.snapshot.activity ?? [], key, () => ({
              key,
              text,
              rank: rank ?? 0,
            }))
          : (next.snapshot.activity ?? []).filter((r) => r.key !== key)
      next.snapshot = { ...next.snapshot, activity }
      return next
    }

    case 'tools': {
      const rows = decode<{ rows?: ToolState[] }>(ev.data)?.rows
      if (rows === undefined) return keepSeq(state, ev.seq)
      next.snapshot = { ...next.snapshot, tools: rows }
      return next
    }

    case 'queued': {
      // Full replacement of pending-prompt rows, oldest first.
      const rows = decode<{ rows?: QueueRow[] }>(ev.data)?.rows
      if (rows === undefined) return keepSeq(state, ev.seq)
      next.snapshot = { ...next.snapshot, queuedRows: rows, queued: rows.length }
      next.pendings = reconcilePendings(next.pendings, rows, new Set())
      return next
    }

    case 'queue.dropped': {
      const d = decode<{ rows?: QueueRow[]; cause?: string }>(ev.data)
      if (d === undefined) return keepSeq(state, ev.seq)
      // Rows are dropped by id: secret redaction means text may be empty.
      const dropped = new Set((d.rows ?? []).map((row) => row.id))
      const rows = (next.snapshot.queuedRows ?? []).filter((row) => !dropped.has(row.id))
      next.snapshot = { ...next.snapshot, queuedRows: rows, queued: rows.length }
      for (const row of d.rows ?? []) {
        if (!isValidId(row.id)) continue
        next.droppedRows = boundedAppend(
          next.droppedRows,
          { id: row.id, text: row.text ?? '', cause: d.cause },
          maxDroppedRows,
        )
      }
      next.pendings = reconcilePendings(next.pendings, undefined, dropped)
      return next
    }

    case 'permission': {
      const d = decode<{ mode?: string }>(ev.data)
      if (d === undefined) return keepSeq(state, ev.seq)
      next.snapshot = { ...next.snapshot, permission: d.mode ?? '' }
      return next
    }

    case 'context': {
      const d = decode<CtlState['context']>(ev.data)
      if (d === undefined) return keepSeq(state, ev.seq)
      next.snapshot = { ...next.snapshot, context: d }
      return next
    }

    case 'idle': {
      const d = decode<{ idle?: boolean }>(ev.data)
      if (d === undefined) return keepSeq(state, ev.seq)
      next.snapshot = { ...next.snapshot, idle: d.idle ?? false }
      return next
    }

    case 'turn.start': {
      const model = decode<{ model?: string }>(ev.data)?.model ?? ''
      next.live = { model, thinking: '', thinkingOpen: true, text: '', textOpen: true, tools: [] }
      next.snapshot = { ...next.snapshot, running: true }
      return next
    }

    case 'thinking.delta':
    case 'text.delta': {
      const delta = decode<{ delta?: string }>(ev.data)?.delta
      if (!delta) return keepSeq(state, ev.seq)
      ensureLive(next)
      const live = next.live!
      next.live =
        ev.event === 'text.delta'
          ? { ...live, text: live.text + delta }
          : { ...live, thinking: live.thinking + delta }
      return next
    }

    case 'thinking.end':
    case 'text.end': {
      ensureLive(next)
      const live = next.live!
      next.live =
        ev.event === 'text.end' ? { ...live, textOpen: false } : { ...live, thinkingOpen: false }
      return next
    }

    case 'tool.start':
    case 'tool.output':
    case 'tool.progress':
    case 'tool.result':
      return applyToolEvent(next, ev)

    case 'diff': {
      const d = decode<{ path?: string; before?: string; after?: string }>(ev.data)
      if (!isValidId(d?.path)) return keepSeq(state, ev.seq)
      next.diffs = boundedAppend(
        next.diffs,
        { path: d.path, before: d.before ?? '', after: d.after ?? '' },
        maxDiffs,
      )
      return next
    }

    case 'notice': {
      const d = decode<{ text?: string; level?: string; key?: string }>(ev.data)
      if (!d?.text) return keepSeq(state, ev.seq)
      const level: NoticeView['level'] =
        d.level === 'warn' || d.level === 'error' ? d.level : 'info'
      if (d.key) {
        // Keyed notices replace in place instead of stacking.
        next.notices = [
          ...next.notices.filter((n) => n.key !== d.key),
          { key: d.key, text: d.text, level, at: Date.now() },
        ].slice(-maxNotices)
      } else {
        next.notices = boundedAppend(
          next.notices,
          { key: '', text: d.text, level, at: Date.now() },
          maxNotices,
        )
      }
      return next
    }

    case 'print': {
      const markdown = decode<{ markdown?: string }>(ev.data)?.markdown
      if (!markdown) return keepSeq(state, ev.seq)
      next.prints = boundedAppend(next.prints, { id: ev.seq, markdown }, maxPrints)
      return next
    }

    case 'turn.end': {
      // Running derives from turn.start/turn.end; the spinner reconciles from
      // snapshots only. Poll-only totals refresh by resnapshotting after this.
      next.live = closeLiveTurn(next.live)
      next.snapshot = { ...next.snapshot, running: false }
      next.lastTurnEndAt = Date.now()
      return next
    }

    case 'session.renamed': {
      const name = decode<{ name?: string }>(ev.data)?.name
      if (!isValidId(name)) return keepSeq(state, ev.seq)
      next.snapshot = { ...next.snapshot, session: { ...next.snapshot.session, name } }
      return next
    }

    case 'interaction.pending': {
      const d = decode<InteractionPending>(ev.data)
      if (!d?.id) return keepSeq(state, ev.seq)
      const existing = next.snapshot.interactions ?? []
      const idx = existing.findIndex((dlg) => dlg.id === d.id)
      // A re-announcement updates in place; a new dialog joins the oldest-first set.
      const interactions =
        idx >= 0 ? existing.map((dlg, i) => (i === idx ? d : dlg)) : [...existing, d]
      next.snapshot = { ...next.snapshot, interactions }
      return next
    }

    case 'interaction.settled': {
      const d = decode<{
        id?: number
        answered?: boolean
        cancelled?: boolean
        index?: number
        indexes?: number[]
      }>(ev.data)
      if (!d?.id) return keepSeq(state, ev.seq)
      next.snapshot = {
        ...next.snapshot,
        interactions: (next.snapshot.interactions ?? []).filter((dlg) => dlg.id !== d.id),
      }
      const own = next.ownDialogs.has(d.id)
      if (!own && (d.answered || d.cancelled)) {
        // Real outcome, never an error: another surface won the answer race.
        next.resolvedElsewhere = boundedAppend(
          state.resolvedElsewhere,
          {
            id: d.id,
            answered: d.answered ?? false,
            cancelled: d.cancelled ?? false,
            index: d.index,
            indexes: d.indexes,
          },
          maxOutcomes,
        )
      }
      if (own) {
        const remaining = new Set(next.ownDialogs)
        remaining.delete(d.id)
        next.ownDialogs = remaining
      }
      return next
    }

    case 'seat.lost': {
      const to = decode<{ to?: string }>(ev.data)?.to
      if (!isValidId(to)) return keepSeq(state, ev.seq)
      next.snapshot = { ...next.snapshot, seat: { held: true, holder: to, yours: false } }
      return next
    }

    case 'session.exit': {
      const reason = decode<{ reason?: string }>(ev.data)?.reason
      next.exitReason = reason ?? ''
      return next
    }

    default:
      // Unknown events are additive changes: ignore them rather than failing.
      return keepSeq(state, ev.seq)
  }
}

function applyStatus(next: AppliedSessionState, ev: WireEvent): AppliedSessionState {
  const d = decode<{
    segment?: { key?: string; text?: string; short?: string; order?: number }
    model?: CtlState['model']
    spinning?: boolean
  }>(ev.data)
  if (d === undefined) return keepSeq(next, ev.seq)

  if (d.segment !== undefined && d.segment !== null) {
    const seg = d.segment
    if (!seg || !isValidId(seg.key)) return keepSeq(next, ev.seq)
    const { key } = seg
    // Keyed family: non-empty text adds or replaces, empty text removes.
    const segments =
      seg.text !== undefined && seg.text !== ''
        ? upsertByKey(next.snapshot.status?.segments ?? [], key, () => ({
            key,
            text: seg.text!,
            short: seg.short,
            order: seg.order ?? 0,
          }))
        : (next.snapshot.status?.segments ?? []).filter((s) => s.key !== key)
    next.snapshot = { ...next.snapshot, status: { segments } }
    return next
  }
  if (d.model !== undefined && d.model !== null) {
    next.snapshot = { ...next.snapshot, model: d.model }
    return next
  }
  if (d.spinning !== undefined && d.spinning !== null) {
    next.snapshot = { ...next.snapshot, spinning: d.spinning }
    return next
  }
  return keepSeq(next, ev.seq)
}

function applyToolEvent(next: AppliedSessionState, ev: WireEvent): AppliedSessionState {
  ensureLive(next)
  const live = next.live!

  switch (ev.event) {
    case 'tool.start': {
      const d = decode<{ id?: string; name?: string; input?: unknown }>(ev.data)
      if (!isValidId(d?.id)) return keepSeq(next, ev.seq)
      return withLive(
        next,
        upsertTool(live.tools, d.id!, (t) => ({
          ...t,
          name: d.name ?? t.name,
          input: d.input !== undefined ? d.input : t.input,
        })),
      )
    }
    case 'tool.output': {
      const d = decode<{ id?: string; delta?: string }>(ev.data)
      if (!isValidId(d?.id) || !d.delta) return keepSeq(next, ev.seq)
      return withLive(
        next,
        upsertTool(live.tools, d.id!, (t) => ({
          ...t,
          outputs: [...t.outputs, d.delta!],
        })),
      )
    }
    case 'tool.progress': {
      const d = decode<{
        id?: string
        name?: string
        path?: string
        bytes?: number
        lines?: number
        done?: boolean
      }>(ev.data)
      if (!isValidId(d?.id)) return keepSeq(next, ev.seq)
      // Progress may name a call before its start: upsert keeps first-seen order.
      return withLive(
        next,
        upsertTool(live.tools, d.id!, (t) => ({
          ...t,
          name: t.name || d.name || '',
          progress: { path: d.path, bytes: d.bytes, lines: d.lines, done: d.done },
        })),
      )
    }
    case 'tool.result': {
      const d = decode<{ id?: string; name?: string; output?: string; error?: boolean }>(ev.data)
      if (!isValidId(d?.id)) return keepSeq(next, ev.seq)
      // Result without a start still renders the header.
      const result: NonNullable<ToolCallView['result']> = {
        output: d.output ?? '',
        error: d.error ?? false,
      }
      if (result.error && result.output !== '') {
        // Upstream's recover path emits its fault-location notice immediately
        // before this result; surface it on the failed card.
        const fault = [...next.notices]
          .reverse()
          .find((n) => n.level === 'error' && n.text.startsWith(result.output))
        if (fault !== undefined) result.fault = fault.text
      }
      return withLive(
        next,
        upsertTool(live.tools, d.id!, (t) => ({
          ...t,
          name: t.name || d.name || '',
          result,
        })),
      )
    }
    default:
      return next
  }
}

// applyResnapshot merges the poll-only facts a snapshot exists to refresh:
// identity, workspace, cwd and usage totals. Event-covered fields stay, since
// stream state may already be newer than the read. Dialogs are the one
// exception: rebuilt from the snapshot and cleared when absent.
function applyResnapshot(state: AppliedSessionState, snap: CtlState): AppliedSessionState {
  const next = cloneShallow(state)
  next.snapshot = {
    ...next.snapshot,
    session: { ...next.snapshot.session, name: snap.session.name },
    workspace: snap.workspace,
    cwd: snap.cwd,
    usage: snap.usage,
    // A drop can lose a turn's end event; the snapshot is where a stuck
    // spinner finally clears.
    spinning: snap.spinning,
    interactions: snap.interactions ?? [],
  }
  const rows = snap.queuedRows ?? []
  next.snapshot = { ...next.snapshot, queuedRows: rows, queued: rows.length }
  next.pendings = reconcilePendings(next.pendings, rows, new Set())

  // Lost-carrier reconciliation: when the snapshot reports no turn in flight,
  // any card still running missed its close (a dropped result, a carrier
  // entry lost to decode failure, a missed turn.end). Force-close them here
  // so no card can sit at "running" forever.
  if (!snap.running && next.live !== null) {
    next.live = closeLiveTurn(next.live)
  }
  return next
}

// closeLiveTurn retires one finished turn's buffer the way ajent's own
// reference client does: painted content stays, streams seal and any call
// without a result closes instead of discarding the whole card. Returns null
// when nothing remains worth painting.
function closeLiveTurn(live: LiveTurn | null): LiveTurn | null {
  if (live === null) return null
  const tools = live.tools.map((t) => (t.result || t.closed ? t : { ...t, closed: true }))
  const empty =
    live.text === '' &&
    live.thinking === '' &&
    tools.every((t) => t.outputs.length === 0 && !t.result)
  return empty
    ? null
    : {
        ...live,
        thinkingOpen: false,
        textOpen: false,
        tools,
      }
}

// --- entry bookkeeping ---

function insertEntry(state: AppliedSessionState, entry: Entry): boolean {
  if (!isValidEntry(entry) || state.entries.has(entry.id)) return false // dedupe by id alone
  const parent = entry.parentId ?? ''
  state.entries.set(entry.id, entry)
  const siblings = state.childIndex.get(parent)
  if (siblings) siblings.push(entry.id)
  else state.childIndex.set(parent, [entry.id])
  resolvePendingCommitted(state, entry)
  return true
}

// A committed message resolves the optimistic rows it landed for via its
// queueIds; several queued prompts may join into one entry.
function resolvePendingCommitted(state: AppliedSessionState, entry: Entry) {
  if (state.pendings.length === 0 || entry.type !== 'message') return
  const ids = decode<MessageEntryData>(entry.data)?.queueIds
  if (!ids || ids.length === 0) return
  const landed = new Set(ids)
  state.pendings = state.pendings.map((p) =>
    landed.has(p.id) && p.state !== 'dropped' ? { ...p, state: 'committed' } : p,
  )
}

// recomputeChain rebuilds the visible branch by walking parent links from
// the snapshot's head back toward a transcript root, cycle-guarded. rooted is
// false when the walk stops at a missing parent that is not the root itself,
// including a head we hold nothing about.
function recomputeChain(state: AppliedSessionState): void {
  const walkedBack: string[] = []
  let rooted: boolean
  if (isValidId(state.snapshot.head)) {
    const seen = new Set<string>()
    let cur: string | undefined = state.snapshot.head
    while (cur && state.entries.has(cur) && !seen.has(cur)) {
      seen.add(cur)
      walkedBack.push(cur)
      cur = state.entries.get(cur)!.parentId ?? ''
    }
    // The walk stops on the root, a missing parent, or a cycle.
    const oldest = walkedBack[walkedBack.length - 1]
    rooted = oldest !== undefined && (state.entries.get(oldest)?.parentId ?? '') === ''
  } else {
    rooted = true // no head at all: nothing to render is as complete as it gets
  }
  const ids = walkedBack.reverse() // oldest first
  state.chain = { ids, rooted, oldestId: ids[0] ?? '' }
}

// reconcilePendings resolves optimistic rows against authoritative queue
// state. Rows named by the queued replacement are queued; rows a drop cleared
// resolve as dropped; everything else keeps waiting for its committed entry.
function reconcilePendings(
  pendings: PendingSubmit[],
  queuedRows: QueueRow[] | undefined,
  droppedIds: Set<string>,
): PendingSubmit[] {
  const queuedSet = new Set((queuedRows ?? []).map((row) => row.id))
  return pendings.map((p) => {
    if (p.state === 'committed') return p
    if (droppedIds.has(p.id)) return { ...p, state: 'dropped' }
    if (queuedSet.has(p.id)) return { ...p, state: 'queued' }
    return p
  })
}

// --- echo fidelity ---

// drainLiveCoveredBy removes what a committed entry already covers from the
// live turn buffer, so streamed content hands off to its committed block
// exactly once instead of rendering twice. Assistant entries carry this
// step's text and thinking; carrier messages fold results under their calls,
// which is when the live tool cards retire.
function drainLiveCoveredBy(state: AppliedSessionState, entry: Entry): void {
  if (!state.live || entry.type !== 'message') return
  const d = decode<MessageEntryData>(entry.data)
  const role = d?.message?.role
  const blocks = contentBlocks(d?.message?.content)
  if (blocks.length === 0) return

  let live = state.live
  let changed = false
  if (role === 'assistant') {
    // Reversed so several same-family blocks peel off the painted tail in
    // content order; forward iteration would only ever match the last one.
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i]
      if (block.type === 'text') {
        const rest = stripSuffix(live.text, textOf(block))
        if (rest !== live.text) {
          live = { ...live, text: rest }
          changed = true
        }
      } else if (block.type === 'thinking') {
        const rest = stripSuffix(live.thinking, textOf(block))
        if (rest !== live.thinking) {
          live = { ...live, thinking: rest }
          changed = true
        }
      }
    }
  } else if (role === 'user') {
    const resultIds = new Set(
      blocks
        .filter((b) => b.type === 'tool_result' && isValidId(toolCallId(b)))
        .map((b) => toolCallId(b)!),
    )
    if (resultIds.size > 0) {
      const tools = live.tools.filter((t) => !resultIds.has(t.id))
      changed = tools.length !== live.tools.length
      live = { ...live, tools }
    }
  }
  if (!changed) return
  state.live = live
  // a fully drained buffer stops painting the pinned row at all
  if (live.text === '' && live.thinking === '' && live.tools.length === 0) {
    state.live = null
  }
}

// stripSuffix removes one occurrence of covered from the end of painted,
// where streamed deltas accumulate. A mismatch means the wire showed less
// than the entry commits; the painted prefix stays and nothing is lost.
function stripSuffix(painted: string, covered: string): string {
  if (covered === '' || !painted.endsWith(covered)) return painted
  return painted.slice(0, painted.length - covered.length)
}

// --- content block helpers shared with the view's own decoding ---

interface ContentBlockData {
  text?: string
  id?: string
  name?: string
  input?: unknown
  callId?: string
}

export interface ContentBlockView {
  type?: string
  data?: ContentBlockData & { mediaType?: string }
}

function contentBlocks(content: unknown): ContentBlockView[] {
  return Array.isArray(content) ? (content as ContentBlockView[]) : []
}

function textOf(block: ContentBlockView): string {
  return block.data?.text ?? ''
}

function toolCallId(block: ContentBlockView): string | undefined {
  const id = block.data?.callId ?? block.data?.id
  return isValidId(id) ? id : undefined
}

// --- small helpers ---

function cloneShallow(state: AppliedSessionState): AppliedSessionState {
  const next = { ...state }
  // Copies of array fields are taken where a case replaces them.
  next.snapshot = { ...state.snapshot }
  next.entries = state.entries // shared; mutations are idempotent under replay
  next.childIndex = state.childIndex
  return next
}

function keepSeq(state: AppliedSessionState, seq: number): AppliedSessionState {
  // The event consumed its number even when the payload dropped.
  if (state.seq === seq) return state
  const next = cloneShallow(state)
  next.seq = seq
  return next
}

function ensureLive(state: AppliedSessionState): void {
  // Deltas and tool events after a lost turn.start still paint.
  if (!state.live) {
    state.live = {
      model: '',
      thinking: '',
      thinkingOpen: false,
      text: '',
      textOpen: true,
      tools: [],
    }
  }
}

function withLive(state: AppliedSessionState, tools: ToolCallView[]): AppliedSessionState {
  const live = state.live!
  return { ...state, live: { ...live, tools } }
}

function upsertTool(
  tools: ToolCallView[],
  id: string,
  update: (existing: ToolCallView) => ToolCallView,
): ToolCallView[] {
  const idx = tools.findIndex((t) => t.id === id)
  if (idx >= 0) return tools.map((t, i) => (i === idx ? update(t) : t))
  return [...tools, update({ id, name: '', outputs: [] })]
}

function upsertByKey<T extends { key: string }>(rows: T[], key: string, build: () => T): T[] {
  const idx = rows.findIndex((row) => row.key === key)
  if (idx < 0) return [...rows, build()]
  return rows.map((row, i) => (i === idx ? build() : row))
}

function boundedAppend<T>(list: T[], item: T, max: number): T[] {
  const trimmed = list.length >= max ? list.slice(list.length - max + 1) : list
  return [...trimmed, item]
}

function isValidId(v: string | undefined | null): v is string {
  return typeof v === 'string' && v !== ''
}

function isValidEntry(entry: Entry | undefined): entry is Entry {
  return entry !== undefined && isValidId(entry.id)
}

// Pure reducer applying /api/stream frames to one session's view state,
// transcribing control-api.md's reconciliation contract in one place:
//
//   - an init replaces everything and resets the watermark
//   - events apply only above the watermark (ephemeral) and dedupe by entry
//     id (committed)
//   - a snapshot applies its event-covered fields only when stamped at or
//     above the applied watermark; poll-only facts always merge
//   - keyed families replace wholesale, empty text removes a row
//   - dialogs are state: rebuilt from snapshots, cleared when absent
//   - a mid-turn session.exit closes the turn itself: no turn.end follows an
//     unsettled exit, and ended sessions never resnapshot
//   - queue rows resolve by id, secret redaction respected
//   - a user-shell card (a `!`/`!!` label) outlives its turn: snapshots keep
//     it, the injected "User Ran:" flush retires it, a count cap bounds it
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
  // Last entry id on the visible chain at arrival; '' when nothing was
  // committed yet. Rendering pins the card beneath its block.
  afterId: string
}

export interface ToolProgressView {
  path?: string
  bytes?: number
  lines?: number
}

export interface ToolCallView {
  id: string
  name: string
  label?: string // header text, kept only for user-shell cards ('! cmd')
  shell?: boolean // a staged user `!`/`!!` run, executing outside any turn
  excluded?: boolean // a `!!` run: output never reaches context or the transcript
  input?: unknown
  progress?: ToolProgressView
  outputs: string[] // streamed deltas painted so far; result.output adds nothing when set
  result?: { output: string; error: boolean; fault?: string }
  verdict?: string // permit outcome chip, e.g. 'auto allowed'
  closed?: boolean // turn ended before a result arrived; never shows "running"
}

// LiveTurn buffers one in-flight turn's stream. Tolerant ordering holds:
// progress may precede start, a result may arrive without a start, and
// turn.end after a lost turn.start is fine.
export interface LiveTurn {
  model: string
  thinking: string
  // Panel intent for the live thinking details. The panel renders
  // uncontrolled and follows only flips of this value, never per render.
  thinkingOpen: boolean
  // Set once a user toggle reaches the applier; programmatic collapses then
  // stop applying for the rest of this buffer.
  thinkingUserToggled?: boolean
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

// PermitVerdict is one tool call's approval outcome, captured from upstream's
// resolve notices so it rides its card instead of stacking above the composer.
export interface PermitVerdict {
  id: string // tool call id the verdict was gated against
  text: string // chip label shown on both the live and committed cards
}

interface PrintCard {
  id: number
  markdown: string
}

type PendingState = 'pending' | 'queued' | 'committed' | 'failed' | 'dropped'

// PendingSubmit is one optimistic prompt row, resolved by queue events or the
// committed entry's queueIds, never by text.
export interface PendingSubmit {
  id: string
  text: string
  state: PendingState
  failedAt?: number // wall clock of the refusal; rendering expires refused rows off it
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
interface ChainInfo {
  ids: string[]
  rooted: boolean // false means older history exists beyond what we hold
  oldestId: string // '' when empty; paging uses it as its before cursor
}

// sessionBusy reports whether a session is mid-turn or parked at a spinner:
// running tracks turn events while spinning reconciles only via snapshots.
// The structural parameter keeps digest rows and snapshots on one rule.
export function sessionBusy(s: { running: boolean; spinning?: boolean }): boolean {
  return s.running || s.spinning === true
}

export interface AppliedSessionState {
  seq: number // last applied event number, everything at or below is dropped

  snapshot: CtlState // event-driven fields; poll-only ones merge via resnapshot
  entries: Map<string, Entry> // every entry received so far, by id
  childIndex: Map<string, string[]> // parent id ('' = root) to child ids in arrival order
  chain: ChainInfo

  live: LiveTurn | null
  notices: NoticeView[]
  permitVerdicts: PermitVerdict[] // newest last, bounded; keeps chips past the handoff
  prints: PrintCard[]
  diffs: DiffView[] // newest last, bounded
  pendings: PendingSubmit[]
  droppedRows: DroppedQueueRow[] // recent queue.dropped rows, badged with their cause
  resolvedElsewhere: DialogOutcome[] // dialogs settled without this viewer's answer
  ownDialogs: Set<number> // dialog ids this client answered; suppresses the outcome card

  exitReason?: string // set once session.exit applies; the run ended, turn state is closed

  lastTurnEndAt: number // wall clock of the last applied turn close; drives resnapshot
  healTick: number // bumped when a branch change left the chain incomplete
}

export type ApplierAction =
  | { type: 'init'; frame: InitFrame }
  | { type: 'event'; event: WireEvent }
  | { type: 'snapshot'; state: CtlState }
  | { type: 'backfill'; entries: Entry[] }
  | { type: 'pendingSubmitted'; pendingId: string; text: string }
  | { type: 'pendingFailed'; pendingId: string }
  | { type: 'liveThinkingToggled'; open: boolean }
  | { type: 'dialogAnswered'; dialogId: number }
  | { type: 'outcomeDismissed'; dialogId: number }

// Bounds keeping the ephemeral surfaces finite across long sessions.
const maxNotices = 50
const maxPermitVerdicts = 50
const maxPrints = 20
const maxDiffs = 10
const maxPendings = 100
const maxDroppedRows = 20
const maxOutcomes = 5
const maxShellCards = 5

// swarmHolder matches pkg/fleet's holderName: upstream announces every swarm
// claim with it, so displacement by this name reads as our own takeover.
const swarmHolder = 'swarm'

export function initialSessionState(): AppliedSessionState {
  return {
    seq: 0,
    snapshot: emptyCtlState(),
    entries: new Map(),
    childIndex: new Map(),
    chain: { ids: [], rooted: true, oldestId: '' },
    live: null,
    notices: [],
    permitVerdicts: [],
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

// MessageEntryData is a committed 'message' entry's data shape, decoded by
// the reducer (queueIds) and transcript derivation (role, content, stop,
// injected/replayed marking) alike.
export interface MessageEntryData {
  message?: { role?: string; content?: unknown }
  stop?: string
  injected?: boolean
  replayed?: boolean
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
      // Stamps the wall clock the render expires against.
      next.pendings = state.pendings.map((p) =>
        p.id === action.pendingId ? { ...p, state: 'failed' as const, failedAt: Date.now() } : p,
      )
      return next
    }
    case 'liveThinkingToggled': {
      // A user toggle takes the panel over: later programmatic collapses
      // (thinking.end, turn end) stop applying for this buffer. Replaying a
      // recorded toggle converges instead of churning the state object.
      const live = state.live
      if (!live || (live.thinkingUserToggled && live.thinkingOpen === action.open)) return state
      const next = cloneShallow(state)
      next.live = { ...live, thinkingOpen: action.open, thinkingUserToggled: true }
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
      if (!isValidEntry(entry)) return next
      // The head follows the committed family wherever it lands.
      next.snapshot = { ...next.snapshot, head: entry.id }
      insertEntry(next, entry)
      drainLiveCoveredBy(next, entry)
      recomputeChain(next)
      return next
    }

    case 'branch.changed': {
      const d = decode<{ head?: string }>(ev.data)
      if (!isValidId(d?.head)) return next
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
      if (!row || !isValidId(row.key)) return next
      const { key, text, rank } = row
      const activity = keyedFamily(
        next.snapshot.activity,
        key,
        text !== undefined && text !== '' ? { key, text, rank: rank ?? 0 } : null,
      )
      next.snapshot = { ...next.snapshot, activity }
      return next
    }

    case 'tools': {
      const rows = decode<{ rows?: ToolState[] }>(ev.data)?.rows
      if (rows === undefined) return next
      next.snapshot = { ...next.snapshot, tools: rows }
      return next
    }

    case 'queued': {
      // Full replacement of pending-prompt rows, oldest first.
      const rows = decode<{ rows?: QueueRow[] }>(ev.data)?.rows
      if (rows === undefined) return next
      next.snapshot = { ...next.snapshot, queuedRows: rows, queued: rows.length }
      next.pendings = reconcilePendings(next.pendings, rows, new Set())
      return next
    }

    case 'queue.dropped': {
      const d = decode<{ rows?: QueueRow[]; cause?: string }>(ev.data)
      if (d === undefined) return next
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
      if (d === undefined) return next
      next.snapshot = { ...next.snapshot, permission: d.mode ?? '' }
      return next
    }

    case 'context': {
      const d = decode<CtlState['context']>(ev.data)
      if (d === undefined) return next
      next.snapshot = { ...next.snapshot, context: d }
      return next
    }

    case 'idle': {
      const d = decode<{ idle?: boolean }>(ev.data)
      if (d === undefined) return next
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
      if (!delta) return next
      ensureLive(next)
      const live = next.live!
      if (ev.event === 'text.delta') {
        next.live = { ...live, text: live.text + delta }
        return next
      }
      // A fresh stream mounts expanded again unless the user owns the panel,
      // matching how a buffer rebuilt from scratch would seed it.
      const thinkingOpen =
        live.thinking === '' && !live.thinkingUserToggled ? true : live.thinkingOpen
      next.live = { ...live, thinking: live.thinking + delta, thinkingOpen }
      return next
    }

    case 'thinking.end':
    case 'text.end': {
      ensureLive(next)
      const live = next.live!
      if (ev.event === 'text.end') {
        next.live = { ...live, textOpen: false }
        return next
      }
      // The end-of-thinking collapse skips a panel the user has toggled.
      if (!live.thinkingUserToggled) next.live = { ...live, thinkingOpen: false }
      return next
    }

    case 'tool.start':
    case 'tool.output':
    case 'tool.progress':
    case 'tool.result':
      return applyToolEvent(next, ev)

    case 'diff': {
      const d = decode<{ path?: string; before?: string; after?: string }>(ev.data)
      if (!isValidId(d?.path)) return next
      next.diffs = boundedAppend(
        next.diffs,
        {
          path: d.path,
          before: d.before ?? '',
          after: d.after ?? '',
          afterId: next.chain.ids.at(-1) ?? '',
        },
        maxDiffs,
      )
      return next
    }

    case 'notice': {
      const d = decode<{ text?: string; level?: string; key?: string }>(ev.data)
      if (!d?.text) return next
      // A permit verdict describes one call's approval, so it rides that card
      // rather than parking above the composer. Without an open card (a lost
      // tool.start, a mid-turn join) the line keeps its notice path instead.
      const label = permitVerdict(d.text)
      if (label !== undefined && attachPermitVerdict(next, label)) return next
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
      if (!markdown) return next
      next.prints = boundedAppend(next.prints, { id: ev.seq, markdown }, maxPrints)
      return next
    }

    case 'turn.end': {
      // Running derives from turn.start/turn.end; the spinner reconciles from
      // snapshots only. Poll-only totals refresh by resnapshotting after this.
      closeTurn(next)
      return next
    }

    case 'session.renamed': {
      const name = decode<{ name?: string }>(ev.data)?.name
      if (!isValidId(name)) return next
      next.snapshot = { ...next.snapshot, session: { ...next.snapshot.session, name } }
      return next
    }

    case 'interaction.pending': {
      const d = decode<InteractionPending>(ev.data)
      if (!d?.id) return next
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
      if (!d?.id) return next
      next.snapshot = {
        ...next.snapshot,
        interactions: (next.snapshot.interactions ?? []).filter((dlg) => dlg.id !== d.id),
      }
      const own = next.ownDialogs.has(d.id)
      if (!own && (d.answered || d.cancelled)) {
        // Real outcome, never an error: another surface won the answer race.
        next.resolvedElsewhere = boundedAppend(
          next.resolvedElsewhere,
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
      if (!isValidId(to)) return next
      // A claim by swarm is this single-user service itself, never a third party.
      const ours = to === swarmHolder
      next.snapshot = { ...next.snapshot, seat: { held: true, holder: to, yours: ours } }
      return next
    }

    case 'session.exit': {
      // Exit can land mid-turn: an unsettled teardown never sends turn.end
      // and the poll backstop skips ended sessions, so the turn closes here.
      // Every step is idempotent under an earlier turn.end.
      const reason = decode<{ reason?: string }>(ev.data)?.reason
      next.exitReason = reason ?? ''
      closeTurn(next)
      // the spinner rides turn boundaries upstream, so it dies with the run
      next.snapshot = { ...next.snapshot, spinning: false }
      return next
    }

    default:
      // Unknown events are additive changes: ignore them rather than failing.
      return next
  }
}

// permitVerdict matches ajent's barrier resolve notices ("Tool auto allowed",
// "Tool allowed for session", "Tool call allowed this time") and returns the
// card chip label, undefined for any other notice. Matched as substrings so
// upstream wording drift never breaks the attach.
function permitVerdict(text: string): string | undefined {
  const t = text.toLowerCase()
  if (t.includes('auto allowed')) return 'auto allowed'
  if (t.includes('allowed for session')) return 'allowed for session'
  if (t.includes('allowed this time')) return 'allowed this time'
  return undefined
}

// attachPermitVerdict stamps label onto the newest call still waiting for a
// result, since a verdict resolves inside its guard chain between start and
// result. It also records the pairing by id so the committed card keeps the
// chip after the live buffer retires. Reports whether an open card took it.
function attachPermitVerdict(state: AppliedSessionState, label: string): boolean {
  const tools = state.live?.tools
  if (!tools) return false
  const idx = tools.findLastIndex((t) => t.result === undefined)
  if (idx < 0) return false
  state.permitVerdicts = [...state.permitVerdicts, { id: tools[idx].id, text: label }].slice(
    -maxPermitVerdicts,
  )
  state.live = {
    ...state.live!,
    tools: tools.map((t, j) => (j === idx ? { ...t, verdict: label } : t)),
  }
  return true
}

function applyStatus(next: AppliedSessionState, ev: WireEvent): AppliedSessionState {
  const d = decode<{
    segment?: {
      key?: string
      text?: string
      short?: string
      order?: number
      counts?: Record<string, number>
    }
    model?: CtlState['model']
    spinning?: boolean
  }>(ev.data)
  if (d === undefined) return next

  if (d.segment !== undefined && d.segment !== null) {
    const seg = d.segment
    if (!isValidId(seg.key)) return next
    const { key } = seg
    const segments = keyedFamily(
      next.snapshot.status?.segments,
      key,
      seg.text !== undefined && seg.text !== ''
        ? {
            key,
            text: seg.text,
            short: seg.short,
            order: seg.order ?? 0,
            counts: seg.counts, // tallies replace whole with the text
          }
        : null,
    )
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
  return next
}

function applyToolEvent(next: AppliedSessionState, ev: WireEvent): AppliedSessionState {
  ensureLive(next)
  const live = next.live!

  switch (ev.event) {
    case 'tool.start': {
      const d = decode<{ id?: string; name?: string; input?: unknown; label?: string }>(ev.data)
      if (!isValidId(d?.id)) return next
      // ajent's stager labels a staged user run with the bangs typed
      // ('! cmd' staged onto context, '!! cmd' excluded from it)
      const shell = typeof d.label === 'string' && d.label.startsWith('!')
      const excluded = typeof d.label === 'string' && d.label.startsWith('!!')
      const tools = upsertTool(live.tools, d.id!, (t) => ({
        ...t,
        name: d.name ?? t.name,
        input: d.input !== undefined ? d.input : t.input,
        label: shell ? d.label : t.label,
        shell: shell || t.shell,
        excluded: excluded || t.excluded,
      }))
      // an excluded `!!` run never flushes, so lingering shell cards need a bound
      const shells = tools.filter((t) => t.shell)
      if (shells.length > maxShellCards) {
        const drop = new Set(shells.slice(0, shells.length - maxShellCards).map((t) => t.id))
        return withLive(
          next,
          tools.filter((t) => !drop.has(t.id)),
        )
      }
      return withLive(next, tools)
    }
    case 'tool.output': {
      const d = decode<{ id?: string; delta?: string }>(ev.data)
      if (!isValidId(d?.id) || !d.delta) return next
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
      }>(ev.data)
      if (!isValidId(d?.id)) return next
      // Progress may name a call before its start: upsert keeps first-seen order.
      return withLive(
        next,
        upsertTool(live.tools, d.id!, (t) => ({
          ...t,
          name: t.name || d.name || '',
          progress: { path: d.path, bytes: d.bytes, lines: d.lines },
        })),
      )
    }
    case 'tool.result': {
      const d = decode<{ id?: string; name?: string; output?: string; error?: boolean }>(ev.data)
      if (!isValidId(d?.id)) return next
      // Result without a start still renders the header.
      const result: NonNullable<ToolCallView['result']> = {
        output: d.output ?? '',
        error: d.error ?? false,
      }
      if (result.error && result.output !== '') {
        // Upstream's recover path emits its fault-location notice immediately
        // before this result; surface it on the failed card.
        const fault = next.notices.findLast(
          (n) => n.level === 'error' && n.text.startsWith(result.output),
        )
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

// applyResnapshot merges one REST snapshot. Poll-only facts (workspace, cwd,
// usage totals, seat) merge unconditionally, since no change event can regress
// under them: releases and swarm's own claims spend no event number, so a
// resnapshot is where SeatBadge learns either. The reply's stamp names the
// watermark the actor had applied when it read: at or above ours, its
// event-covered fields land wholesale since they fold every event this client
// has seen; below, events already moved past the read and only those facts
// merge, so a late response can never empty a dialog, drop the live turn's
// buffer, or queue rows the stream just announced.
function applyResnapshot(state: AppliedSessionState, snap: CtlState): AppliedSessionState {
  const fresh = snap.seq === undefined || snap.seq >= state.seq
  const next = cloneShallow(state)
  next.snapshot = {
    ...next.snapshot,
    workspace: snap.workspace,
    cwd: snap.cwd,
    usage: snap.usage,
    seat: snap.seat,
  }
  if (!fresh) return next
  // An exit is final for turn state: a read that raced it can still carry the
  // pre-exit running/spinner facts, and no later poll exists to correct them.
  // Only the poll-only facts above keep merging.
  if (state.exitReason !== undefined) return next

  next.snapshot = {
    ...next.snapshot,
    session: { ...next.snapshot.session, name: snap.session.name },
    // A drop can lose a turn's end event; the snapshot is where a stuck
    // spinner finally clears.
    spinning: snap.spinning,
    interactions: snap.interactions ?? [],
  }
  const rows = snap.queuedRows ?? []
  next.snapshot = { ...next.snapshot, queuedRows: rows, queued: rows.length }
  next.pendings = reconcilePendings(next.pendings, rows, new Set())

  // Lost-carrier reconciliation: when the snapshot reports no turn in flight,
  // any leftover buffer missed its close (dropped result, lost carrier entry,
  // a missed turn.end). The commit handoff drains first: this fires ~100 ms
  // after turn.end and the poll is the backstop, so what remains is residue.
  // Drop it outright instead of sealing. Committed entries own the content
  // from here, and kept residue would pin its panel forever. A user-shell
  // card is the one exception: a staged run executes outside any turn and
  // nothing commits its output until the flush entry lands, so it survives.
  if (!snap.running && next.live !== null) {
    next.live = shellOnlyLive(next.live)
  }
  return next
}

// shellOnlyLive strips one not-running buffer down to its user-shell cards,
// dropping the sealed stream residue. Returns null when no shell card stays.
function shellOnlyLive(live: LiveTurn): LiveTurn | null {
  const tools = live.tools.filter((t) => t.shell)
  if (tools.length === 0) return null
  return {
    ...live,
    thinking: '',
    thinkingOpen: false,
    text: '',
    textOpen: false,
    tools,
  }
}

// closeLiveTurn retires one finished turn's buffer the way ajent's own
// reference client does: painted content stays, streams seal and any call
// without a result closes instead of discarding the whole card. Returns null
// when nothing remains worth painting.
function closeLiveTurn(live: LiveTurn | null): LiveTurn | null {
  if (live === null) return null
  // A staged shell run outlives the turn: its card neither seals nor counts
  // the buffer empty, so it keeps painting until its own result arrives.
  const tools = live.tools.map((t) =>
    t.result || t.closed || t.shell ? t : { ...t, closed: true },
  )
  const empty =
    live.text === '' &&
    live.thinking === '' &&
    tools.every((t) => t.outputs.length === 0 && !t.result && !t.shell)
  if (empty) return null
  return {
    ...live,
    // the resting state at commit is collapsed unless the user owns the panel;
    // the committed block's own default keeps it collapsed after handoff
    thinkingOpen: live.thinkingUserToggled ? live.thinkingOpen : false,
    textOpen: false,
    tools,
  }
}

// closeTurn settles one finished turn: the buffer seals, running clears and
// the resnapshot clock moves. Idempotent under an earlier turn.end.
function closeTurn(state: AppliedSessionState): void {
  state.live = closeLiveTurn(state.live)
  state.snapshot = { ...state.snapshot, running: false }
  state.lastTurnEndAt = Date.now()
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
// including a head we hold nothing about. Diffs prune to anchors still on
// the rebuilt branch ('' predates any entry and stays), so rewound-away
// cards vanish with the history they described.
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
  if (state.diffs.length > 0) {
    const onBranch = new Set(ids)
    state.diffs = state.diffs.filter((d) => d.afterId === '' || onBranch.has(d.afterId))
  }
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
  const blocks = Array.isArray(d?.message?.content) ? (d.message.content as ContentBlockView[]) : []
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
    // A staged run's flush commits as an injected "User Ran: <cmd>" message:
    // its finished cards retire, the output is transcript history now. Both
    // sides compare on the command's first line.
    const text = textOf(blocks[0])
    const flushed =
      d?.injected && text.startsWith(userRanPrefix)
        ? firstLine(text.slice(userRanPrefix.length))
        : undefined
    const retired = (t: ToolCallView): boolean =>
      (resultIds.size > 0 && resultIds.has(t.id)) ||
      (flushed !== undefined &&
        t.shell === true &&
        t.result !== undefined &&
        firstLine((t.label ?? '').replace(/^!+ /, '')) === flushed)
    const tools = live.tools.filter((t) => !retired(t))
    changed = tools.length !== live.tools.length
    live = { ...live, tools }
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

// userRanPrefix opens the injected message a staged run's flush commits; it
// also marks the delivered block that shares the live card's styling.
export const userRanPrefix = 'User Ran: '

function firstLine(text: string): string {
  const i = text.indexOf('\n')
  return i === -1 ? text : text.slice(0, i)
}

// --- content block helpers shared with the view's own decoding ---

interface ContentBlockData {
  text?: string
  id?: string
  name?: string
  input?: unknown
  callId?: string
  toolName?: string
  isError?: boolean
  display?: string
  content?: unknown
  data?: string // base64 image body
}

export interface ContentBlockView {
  type?: string
  data?: ContentBlockData & { mediaType?: string }
}

function textOf(block: ContentBlockView): string {
  return block.data?.text ?? ''
}

// toolCallId reads a block's call identity, accepting both wire spellings.
export function toolCallId(block: ContentBlockView): string | undefined {
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

function ensureLive(state: AppliedSessionState): void {
  // Deltas and tool events after a lost turn.start still paint; every buffer
  // mounts expanded, so a mid-turn join streams with the panel open too.
  if (!state.live) {
    state.live = {
      model: '',
      thinking: '',
      thinkingOpen: true,
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

// keyedFamily applies the keyed family contract: a row adds or replaces by
// key, null removes.
function keyedFamily<T extends { key: string }>(
  rows: T[] | undefined,
  key: string,
  row: T | null,
): T[] {
  if (row === null) return (rows ?? []).filter((r) => r.key !== key)
  return upsertByKey(rows ?? [], key, () => row)
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

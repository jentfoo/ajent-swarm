// SessionStore owns every session's reconciled view state outside React: it
// subscribes the shared stream once per session, applies frames with the one
// watermark machine, resnapshots poll-only facts and heals branch changes.
//
// Views acquire and release sessions; a small LRU of recently viewed sessions
// stays subscribed and warm after their last view unmounts, so switching in
// the focus queue or re-tiling is instant and a resnapshot only happens on real
// reconnects. Multiple views of one session share one store entry, one
// subscription and one AppliedSessionState.
import { applierReducer, initialSessionState } from '../state/eventApplier'
import type { ApplierAction, AppliedSessionState } from '../state/eventApplier'
import { sessions as sessionAPI } from '../api/endpoints'
import type { SwarmStream } from './swarmStream'

// Warm budget: how many unreferenced sessions keep their subscriptions.
const maxWarm = 4
const resnapshotMs = 20_000
const resnapshotAfterTurnMs = 100
const pageLimit = 200
const maxHealPages = 5

interface StoreEntry {
  state: AppliedSessionState
  refs: number
  listeners: Set<() => void>
  unsub: (() => void) | null // frames subscription while the entry exists
  pollTimer: ReturnType<typeof setInterval> | null
  turnTimer: ReturnType<typeof setTimeout> | null
  healToken: number // bumps to cancel an in-flight heal loop
  initTick: number // bumps on every stream rebuild; older snapshot reads drop
}

export class SessionStore {
  private readonly stream: SwarmStream
  private readonly entries = new Map<string, StoreEntry>()
  private disposed = false

  constructor(stream: SwarmStream) {
    this.stream = stream
  }

  // acquire registers one mounted view; the returned release is idempotent.
  acquire(sessionId: string): () => void {
    const entry = this.ensureEntry(sessionId)
    entry.refs += 1
    this.entries.delete(sessionId) // re-insert: most recently used first
    this.entries.set(sessionId, entry)
    let released = false
    return () => {
      if (released) return
      released = true
      this.release(sessionId)
    }
  }

  // subscribeState drives useSyncExternalStore for one session's state.
  subscribeState(sessionId: string, cb: () => void): () => void {
    const entry = this.ensureEntry(sessionId)
    entry.listeners.add(cb)
    return () => entry.listeners.delete(cb)
  }

  // peek returns the current state object; stable identity between actions.
  peek(sessionId: string): AppliedSessionState {
    return this.entries.get(sessionId)?.state ?? emptyState
  }

  // dispatch feeds local actions through the same reducer the frames use.
  dispatch(sessionId: string, action: ApplierAction): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    this.apply(sessionId, entry, action)
  }

  // loadOlder pages one block of committed history older than what we hold,
  // answering whether a page arrived (false when the server ran dry).
  async loadOlder(sessionId: string): Promise<boolean> {
    const entry = this.entries.get(sessionId)
    if (!entry || entry.state.chain.oldestId === '') return false
    try {
      const res = await sessionAPI.entries(sessionId, entry.state.chain.oldestId, pageLimit)
      this.apply(sessionId, entry, { type: 'backfill', entries: res.entries })
      return res.entries.length > 0
    } catch {
      return false // a failed page leaves state untouched; the button stays
    }
  }

  // dispose stops every timer and subscription; used by provider cleanup.
  // A later acquire revives the store, matching the stream client's contract.
  dispose(): void {
    for (const entry of [...this.entries.values()]) {
      this.dropEntry(entry)
    }
    this.entries.clear()
    this.disposed = true
  }

  // --- internals ---

  private ensureEntry(sessionId: string): StoreEntry {
    this.disposed = false // StrictMode's simulated unmount must not stick
    let entry = this.entries.get(sessionId)
    if (entry) return entry
    entry = {
      state: initialSessionState(),
      refs: 0,
      listeners: new Set(),
      unsub: null,
      pollTimer: null,
      turnTimer: null,
      healToken: 0,
      initTick: 0,
    }
    const e = entry
    e.unsub = this.stream.subscribe(sessionId, (frame) => {
      if (frame.type === 'init') {
        e.initTick += 1 // the rebuild invalidates any read taken before it
        this.apply(sessionId, e, { type: 'init', frame })
      } else if (frame.type === 'event') {
        this.apply(sessionId, e, { type: 'event', event: frame.event })
      }
    })
    this.entries.set(sessionId, entry)
    entry.pollTimer = setInterval(() => this.resnapshot(sessionId), resnapshotMs)
    return entry
  }

  private release(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    entry.refs = Math.max(0, entry.refs - 1)
    if (entry.refs > 0) return
    // Keep recent sessions warm; evict the coldest unreferenced ones beyond cap.
    const warm = [...this.entries].filter(([, e]) => e.refs === 0)
    const excess = Math.max(0, warm.length - maxWarm)
    for (const [id, cold] of warm.slice(0, excess)) {
      this.dropEntry(cold)
      this.entries.delete(id)
    }
  }

  private dropEntry(entry: StoreEntry): void {
    entry.unsub?.()
    if (entry.pollTimer !== null) clearInterval(entry.pollTimer)
    if (entry.turnTimer !== null) clearTimeout(entry.turnTimer)
    entry.healToken += 1 // any in-flight heal loop sees the bump and stops
    entry.listeners.clear()
  }

  private apply(sessionId: string, entry: StoreEntry, action: ApplierAction): void {
    const prev = entry.state
    const next = applierReducer(prev, action)
    if (next === prev) return
    entry.state = next
    for (const cb of [...entry.listeners]) cb()

    // A finished turn is the resnapshot trigger: usage totals ride poll-only.
    if (action.type === 'event' && next.lastTurnEndAt !== prev.lastTurnEndAt) {
      this.scheduleTurnResnapshot(sessionId, entry)
    }
    // A branch change that left the chain incomplete heals by paging, falling
    // back to a full resync when the server cannot serve the missing chain.
    if (action.type === 'event' && next.healTick !== prev.healTick) {
      void this.heal(sessionId, entry)
    }
  }

  private scheduleTurnResnapshot(sessionId: string, entry: StoreEntry): void {
    if (entry.turnTimer !== null) clearTimeout(entry.turnTimer)
    entry.turnTimer = setTimeout(() => {
      entry.turnTimer = null
      void this.resnapshot(sessionId)
    }, resnapshotAfterTurnMs)
  }

  // resnapshot merges the poll-only facts; skipped while the tab is hidden,
  // mirroring the digest polls, and for sessions that ended for good. A read
  // that raced a stream rebuild drops: init replaced state wholesale, so the
  // response predates what the client now holds.
  private async resnapshot(sessionId: string): Promise<void> {
    if (this.disposed) return
    if (document.visibilityState === 'hidden') return
    const phase = this.stream.sessionPhase(sessionId)
    if (phase === 'ended') return
    const entry = this.entries.get(sessionId)
    if (!entry) return
    const initTick = entry.initTick
    try {
      const snap = await sessionAPI.snapshot(sessionId)
      const current = this.entries.get(sessionId)
      if (current !== entry || current.initTick !== initTick) return // rebuilt mid-read
      this.apply(sessionId, current, { type: 'snapshot', state: snap })
    } catch {
      // Unknown sessions flip the phase through error frames instead.
    }
  }

  // heal pages older history back until the new branch roots locally; a dry
  // server or a network miss falls back to the stream's full resync.
  private async heal(sessionId: string, entry: StoreEntry): Promise<void> {
    const token = ++entry.healToken
    const alive = () => this.entries.get(sessionId) === entry && entry.healToken === token

    const start = entry.state
    if (start.chain.ids.length === 0) {
      this.stream.resync(sessionId) // the new head is unknown entirely
      return
    }
    let cursor = start.chain.oldestId
    for (let page = 0; page < maxHealPages && alive(); page++) {
      try {
        const res = await sessionAPI.entries(sessionId, cursor, pageLimit)
        if (!alive()) return
        this.apply(sessionId, entry, { type: 'backfill', entries: res.entries })
        const oldest = res.entries[0]
        if (oldest && (oldest.parentId ?? '') === '') return // a root is now local
        if (!oldest || !res.cursor) break // server is dry; rebuild via resync
        cursor = oldest.id
      } catch {
        break // network trouble; the resync below rebuilds from scratch
      }
    }
    if (alive()) this.stream.resync(sessionId)
  }
}

// Shared empty state for sessions with no store entry: useSyncExternalStore
// needs a stable identity between renders, not a fresh object per read.
const emptyState = initialSessionState()

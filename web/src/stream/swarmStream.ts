// One multiplexed WebSocket to /api/stream shared by every view. Browsers
// allow only a handful of connections per origin under HTTP/1.1, so tiling
// must fit the budget: subscriptions are reference counted per session id,
// two views of one session hold one subscription.
//
// The client carries heartbeat awareness (a stalled socket closes and
// reconnects), exponential backoff between attempts, and an immediate resync
// when the tab becomes visible again, since backgrounded mobile tabs drop
// sockets and throttle timers.
import type { ServerFrame } from '../api/types'

export type SocketState = 'connecting' | 'open' | 'closed'

// Per-session phase. Ended versus lost is distinguished by the backend's
// child/exit facts: a clean exit announces itself, everything else that stops
// delivery reads as lost.
export type SessionPhase = 'connecting' | 'live' | 'resyncing' | 'ended' | 'lost'

// SocketLike is the slice of WebSocket the client drives; tests inject a mock.
// The handler signatures mirror lib.dom's own so a real WebSocket satisfies
// it structurally without casts.
interface SocketLike {
  send(data: string): void
  close(): void
  onopen: ((this: WebSocket, ev: Event) => unknown) | null
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null
  onerror: ((this: WebSocket, ev: Event) => unknown) | null
}

interface SwarmStreamOptions {
  url?: string // default: ws(s)://<location.host>/api/stream
  socketFactory?: (url: string) => SocketLike // injectable for tests
  backoffBaseMs?: number
  backoffMaxMs?: number
  jitter?: boolean // randomized backoff spread, off in tests
  staleAfterMs?: number // no frame for this long closes the socket
}

type FrameListener = (frame: ServerFrame) => void

const defaultStaleAfterMs = 75_000 // heartbeats ride every 20s; allow two misses

// A subscribe or sync refused with a subscription-level error retries on
// this backoff while any view still holds the session, then gives up as lost.
export const resubscribeBaseMs = 500
export const resubscribeMaxMs = 5_000
const resubscribeMaxAttempts = 12 // about a minute of trying before 'lost'

// Error codes meaning our wire subscription is absent or was refused, so the
// subscribe frame goes out again under the backoff: a session the fleet does
// not track yet (unknown_session), a Subscribe failure worth retrying
// (subscribe_failed), and a sync naming no live subscription
// (not_subscribed). Anything else names no recoverable subscription state.
const resubscribeCodes = new Set(['unknown_session', 'subscribe_failed', 'not_subscribed'])

export class SwarmStream {
  private readonly url: string
  private readonly makeSocket: (url: string) => SocketLike
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly jitter: boolean
  private readonly staleAfterMs: number

  private socket: SocketLike | null = null
  private socketStateValue: SocketState = 'closed'
  private connListeners = new Set<() => void>()

  private refs = new Map<string, number>()
  private listeners = new Map<string, Set<FrameListener>>()
  private phases = new Map<string, SessionPhase>()
  private phaseListeners = new Map<string, Set<() => void>>()

  private retryAttempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private watchdog: ReturnType<typeof setInterval> | null = null
  private lastFrameAt = 0
  private destroyed = false
  // per-session resubscribe backoff after a refused subscribe
  private resubTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private resubAttempts = new Map<string, number>()

  constructor(opts: SwarmStreamOptions = {}) {
    this.url = opts.url ?? defaultStreamURL()
    this.makeSocket = opts.socketFactory ?? ((u) => new WebSocket(u))
    this.backoffBaseMs = opts.backoffBaseMs ?? 500
    this.backoffMaxMs = opts.backoffMaxMs ?? 8_000
    this.jitter = opts.jitter ?? true
    this.staleAfterMs = opts.staleAfterMs ?? defaultStaleAfterMs
    document.addEventListener('visibilitychange', this.handleVisibility)
  }

  // --- public surface ---

  // subscribe registers one view on a session's frames. Repeat subscriptions
  // reference count; the wire sees one subscribe until the last view leaves.
  subscribe(sessionId: string, onFrame: FrameListener): () => void {
    const refs = (this.refs.get(sessionId) ?? 0) + 1
    this.refs.set(sessionId, refs)
    let set = this.listeners.get(sessionId)
    if (!set) {
      set = new Set()
      this.listeners.set(sessionId, set)
      // First view of the session: join it on the wire unless a reconnect is
      // already queued to carry every ref'd session.
      if (this.isOpen()) {
        this.sendFrame({ type: 'subscribe', sessionId })
        this.setPhase(sessionId, 'connecting')
      } else {
        this.ensureSocket()
      }
    }
    set.add(onFrame)

    return () => {
      const current = this.refs.get(sessionId)
      if (current === undefined) return // already fully unsubscribed
      if (current > 1) {
        this.refs.set(sessionId, current - 1)
        return
      }
      this.refs.delete(sessionId)
      this.listeners.delete(sessionId)
      this.phases.delete(sessionId)
      this.phaseListeners.delete(sessionId)
      // A reopened view starts over: fresh budget for its subscribe retries.
      this.resubAttempts.delete(sessionId)
      this.cancelResubscribe(sessionId)
      if (this.isOpen()) this.sendFrame({ type: 'unsubscribe', sessionId })
    }
  }

  // connect opens the shared socket eagerly so the global connection banner
  // reflects reality before any view subscribes; later subscribes ride it.
  connect(): void {
    if (this.destroyed || this.socket !== null) return
    this.retryAttempt = 0
    this.ensureSocket()
  }

  // resync asks the backend to re-push one session's init, rebuilding state in
  // place without dropping other subscriptions. An ended session holds its
  // final view; there is nothing left to rebuild.
  resync(sessionId: string): void {
    if (!this.refs.has(sessionId)) return
    if (this.phases.get(sessionId) === 'ended') return
    if (this.isOpen()) this.sendFrame({ type: 'sync', sessionId })
  }

  connectionState(): SocketState {
    return this.socketStateValue
  }

  sessionPhase(sessionId: string): SessionPhase {
    return this.phases.get(sessionId) ?? 'connecting'
  }

  onConnectionChange(cb: () => void): () => void {
    this.connListeners.add(cb)
    return () => this.connListeners.delete(cb)
  }

  onSessionPhaseChange(sessionId: string, cb: () => void): () => void {
    let set = this.phaseListeners.get(sessionId)
    if (!set) {
      set = new Set()
      this.phaseListeners.set(sessionId, set)
    }
    set.add(cb)
    return () => {
      set.delete(cb)
      if (set.size === 0 && !this.listeners.has(sessionId)) this.phaseListeners.delete(sessionId)
    }
  }

  // disconnect tears the socket and timers down while keeping the client
  // usable; a later subscribe reconnects on demand. Used by provider cleanup.
  disconnect(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    for (const timer of this.resubTimers.values()) clearTimeout(timer)
    this.resubTimers.clear()
    this.resubAttempts.clear()
    if (this.watchdog !== null) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
    // The close handler sees a stale socket and stays quiet.
    const ws = this.socket
    this.socket = null
    ws?.close()
  }

  // destroy tears the client down permanently; used by tests.
  destroy(): void {
    this.destroyed = true
    document.removeEventListener('visibilitychange', this.handleVisibility)
    this.disconnect()
  }

  // --- internals ---

  private isOpen(): boolean {
    return this.socketStateValue === 'open'
  }

  private setState(state: SocketState) {
    if (this.socketStateValue === state) return
    this.socketStateValue = state
    for (const cb of this.connListeners) cb()
  }

  private ensureSocket() {
    if (this.destroyed || this.socket !== null) return
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.setState('connecting')
    const ws = this.makeSocket(this.url)
    this.socket = ws

    ws.onopen = () => {
      if (ws !== this.socket) return
      this.lastFrameAt = Date.now()
      this.retryAttempt = 0
      this.setState('open')
      // Re-join every ref'd session; a fresh socket knows no subscriptions.
      for (const sessionId of this.listeners.keys()) {
        if (this.phases.get(sessionId) === 'ended') continue // definitive end, never rejoins
        this.sendFrame({ type: 'subscribe', sessionId })
        if (!this.phases.has(sessionId)) this.setPhase(sessionId, 'connecting')
        else this.setPhase(sessionId, 'resyncing') // state exists; init will replace it
      }
      if (this.watchdog === null) {
        this.watchdog = setInterval(this.checkStale, Math.min(this.staleAfterMs / 3, 5_000))
      }
    }

    ws.onmessage = (ev: MessageEvent) => {
      if (ws !== this.socket) return
      this.lastFrameAt = Date.now()
      let frame: ServerFrame
      try {
        frame = JSON.parse(String(ev.data)) as ServerFrame
      } catch {
        return // a malformed frame never takes the connection down
      }
      this.route(frame)
    }

    ws.onclose = () => {
      if (ws !== this.socket) return
      this.socket = null
      this.setState('closed')
      if (this.watchdog !== null) {
        clearInterval(this.watchdog)
        this.watchdog = null
      }
      // Held state is stale until the next init; keep it visible while we retry.
      for (const sessionId of this.listeners.keys()) {
        if (this.phases.get(sessionId) === 'ended') continue // an exit outlives socket churn
        this.setPhase(sessionId, this.phases.has(sessionId) ? 'resyncing' : 'connecting')
      }
      this.scheduleReconnect()
    }

    ws.onerror = () => {
      // The close event follows; nothing to do beyond keeping state coherent.
    }
  }

  private scheduleReconnect() {
    if (this.destroyed || this.retryTimer !== null) return
    const exp = Math.min(this.backoffBaseMs * 2 ** this.retryAttempt, this.backoffMaxMs)
    const spread = this.jitter ? Math.random() * this.backoffBaseMs : 0
    this.retryAttempt += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.destroyed) this.ensureSocket()
    }, exp + spread)
  }

  private checkStale = () => {
    if (!this.isOpen() || this.lastFrameAt === 0) return
    // Backgrounded tabs throttle timers, so a late check is normal; only real
    // staleness closes the socket, and close drives reconnect.
    if (Date.now() - this.lastFrameAt > this.staleAfterMs) {
      this.socket?.close()
    }
  }

  private handleVisibility = () => {
    if (document.visibilityState !== 'visible') return
    if (this.isOpen()) {
      // Backgrounded tabs miss frames; every held view resnapshots at once.
      for (const sessionId of this.listeners.keys()) {
        this.resync(sessionId)
      }
      return
    }
    // A closed socket reconnects immediately instead of waiting out backoff.
    if (this.socket === null) {
      if (this.retryTimer !== null) clearTimeout(this.retryTimer)
      this.retryTimer = null
      this.retryAttempt = 0
      this.ensureSocket()
    }
  }

  private sendFrame(frame: { type: string; sessionId?: string }) {
    if (!this.isOpen() || !this.socket) return
    try {
      this.socket.send(JSON.stringify(frame))
    } catch {
      // Send failures surface through close; reconnect resubscribes.
    }
  }

  private route(frame: ServerFrame) {
    switch (frame.type) {
      case 'heartbeat':
        return
      case 'init': {
        this.resubAttempts.delete(frame.sessionId)
        this.cancelResubscribe(frame.sessionId) // a live init means we got in
        this.setPhase(frame.sessionId, 'live')
        this.dispatch(frame.sessionId, frame)
        return
      }
      case 'child': {
        if (frame.state === 'exited' || frame.state === 'gone') {
          // ended for good: no point re-asking for a dead session's stream
          this.resubAttempts.delete(frame.sessionId)
          this.cancelResubscribe(frame.sessionId)
        }
        if (frame.state === 'exited') this.setPhase(frame.sessionId, 'ended')
        else if (frame.state === 'gone') this.setPhase(frame.sessionId, 'lost')
        else if (frame.state === 'reconnecting') this.setPhase(frame.sessionId, 'resyncing')
        this.dispatch(frame.sessionId, frame)
        return
      }
      case 'error': {
        // A refused subscribe or sync means the wire subscription is gone
        // while a view still holds the session: retry under backoff, so one
        // the fleet does not track yet (a just-resumed child) joins as soon
        // as its actor appears.
        if ('sessionId' in frame && typeof frame.sessionId === 'string') {
          if (resubscribeCodes.has(frame.code)) this.scheduleResubscribe(frame.sessionId)
          this.dispatch(frame.sessionId, frame)
        }
        return
      }
      default:
        this.dispatch((frame as { sessionId: string }).sessionId, frame)
    }
  }

  private dispatch(sessionId: string, frame: ServerFrame) {
    const set = this.listeners.get(sessionId)
    if (!set) return
    for (const listener of set) listener(frame)
  }

  // scheduleResubscribe re-sends one session's subscribe after a backoff, so a
  // refused or retired subscription rejoins as soon as the fleet can serve it.
  // Exhausted attempts mark the phase lost; an ended session never retries.
  private scheduleResubscribe(sessionId: string): void {
    if (this.destroyed || !this.refs.has(sessionId)) return
    if (this.phases.get(sessionId) === 'ended') return // definitive end, stops retrying
    const attempt = this.resubAttempts.get(sessionId) ?? 0
    if (attempt >= resubscribeMaxAttempts) {
      this.setPhase(sessionId, 'lost')
      return
    }
    this.resubAttempts.set(sessionId, attempt + 1)
    this.cancelResubscribe(sessionId)
    const wait = Math.min(resubscribeBaseMs * 2 ** attempt, resubscribeMaxMs)
    const timer = setTimeout(() => {
      this.resubTimers.delete(sessionId)
      if (this.destroyed || !this.refs.has(sessionId)) return
      this.setPhase(sessionId, 'connecting')
      this.sendFrame({ type: 'subscribe', sessionId })
    }, wait)
    this.resubTimers.set(sessionId, timer)
  }

  private cancelResubscribe(sessionId: string): void {
    const timer = this.resubTimers.get(sessionId)
    if (timer !== undefined) clearTimeout(timer)
    this.resubTimers.delete(sessionId)
  }

  private setPhase(sessionId: string, phase: SessionPhase) {
    if (this.phases.get(sessionId) === phase) return
    this.phases.set(sessionId, phase)
    const cbs = this.phaseListeners.get(sessionId)
    if (cbs) for (const cb of [...cbs]) cb()
  }
}

function defaultStreamURL(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/api/stream`
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionStore } from './sessionStore'
import { SwarmStream } from './swarmStream'
import { MockWebSocket } from '../test/mockWebSocket'
import type { ServerFrame } from '../api/types'

// The store rides the real stream client over a mock socket and fetch mocks
// shaped like the Go handlers: warm entries keep their subscription with no
// view mounted, and two views of one session share one state object.
function snapshotFor(sessionId: string) {
  const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  return {
    session: { id: sessionId },
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
    usage: { turns: 0, total: zeroUsage, child: zeroUsage, estimatedTurns: 0 },
    context: { used: 0, window: 0, reserve: 0, compact: 0, estimated: false },
    running: false,
    idle: true,
    spinning: false,
    queued: 0,
    queuedRows: [],
    seat: { held: false, yours: false },
  }
}

function eventFrame(sessionId: string, name: string, seq: number, data?: unknown): ServerFrame {
  return { type: 'event', sessionId, event: { event: name, seq, data } }
}

describe('SessionStore', () => {
  let stream: SwarmStream
  let store: SessionStore

  beforeEach(() => {
    vi.useFakeTimers()
    MockWebSocket.instances = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) => {
        const path = String(url)
        const id = /\/api\/sessions\/([^/]+)\/snapshot/.exec(path)?.[1]
        return Promise.resolve(Response.json(id ? snapshotFor(id) : {}))
      }),
    )
    stream = new SwarmStream({
      url: 'ws://swarm/api/stream',
      socketFactory: (u) => new MockWebSocket(u),
      jitter: false,
    })
    store = new SessionStore(stream)
  })

  // a fresh stream per test still leaves the old one listening on document
  // visibility, and its fake timers pending: tear both down like swarmStream.test
  afterEach(() => {
    stream.destroy()
    vi.useRealTimers()
  })

  function openSocket(): MockWebSocket {
    const ws = MockWebSocket.instances.at(-1)
    if (!ws) throw new Error('no socket created')
    ws.open()
    return ws
  }

  function sentFrames(ws: MockWebSocket): unknown[] {
    return ws.sent.map((raw) => JSON.parse(raw))
  }

  // Holds every fetch reply for manual release, in call order, so tests land
  // overlapping responses in an order of their choosing.
  function holdFetches(): Array<(res: Response) => void> {
    const resolvers: Array<(res: Response) => void> = []
    vi.mocked(fetch).mockImplementation(
      () => new Promise<Response>((resolve) => resolvers.push(resolve)),
    )
    return resolvers
  }

  it('shares one state object and one subscription between two views', async () => {
    const release1 = store.acquire('s1')
    const release2 = store.acquire('s1')
    openSocket()

    expect(sentFrames(MockWebSocket.instances[0])).toEqual([{ type: 'subscribe', sessionId: 's1' }])

    const seen: string[] = []
    const stop = store.subscribeState('s1', () => seen.push('changed'))
    MockWebSocket.instances[0].message({
      type: 'init',
      sessionId: 's1',
      state: snapshotFor('s1'),
      entries: [],
    })
    expect(seen).toEqual(['changed'])
    expect(store.peek('s1').snapshot.session.id).toBe('s1')

    // one release keeps the session subscribed for the other view
    release1()
    expect(sentFrames(MockWebSocket.instances[0])).toHaveLength(1)
    release2()
    // last release keeps it warm: still no unsubscribe
    expect(sentFrames(MockWebSocket.instances[0])).toHaveLength(1)
    stop()
  })

  it('keeps recently viewed sessions warm and evicts beyond the cap', async () => {
    // four released sessions stay subscribed; a fifth evicts the coldest
    for (const id of ['a', 'b', 'c', 'd']) store.acquire(id)()
    store.acquire('e')()
    const ws = openSocket()
    await vi.advanceTimersByTimeAsync(0)

    const subscribes = () =>
      sentFrames(ws).filter((f) => (f as { type: string }).type === 'subscribe')
    expect(subscribes().map((f) => (f as { sessionId: string }).sessionId)).toEqual([
      'b',
      'c',
      'd',
      'e',
    ])

    // a warm session re-acquires with no resubscribe: switching is instant
    const warm = store.acquire('b')
    expect(subscribes()).toHaveLength(4)
    warm()

    // one more cold session evicts the next coldest with a real unsubscribe
    store.acquire('f')()
    const unsubs = sentFrames(ws).filter((f) => (f as { type: string }).type === 'unsubscribe')
    expect(unsubs.map((f) => (f as { sessionId: string }).sessionId)).toEqual(['c'])
  })

  it('applies events to warm sessions and resnapshots after a turn ends', async () => {
    store.acquire('s1')
    const ws = openSocket()
    ws.message({ type: 'init', sessionId: 's1', state: snapshotFor('s1'), entries: [] })

    ws.message(eventFrame('s1', 'turn.start', 1, { model: 'm' }))
    expect(store.peek('s1').snapshot.running).toBe(true)

    const fetchMock = vi.mocked(fetch)
    fetchMock.mockClear()
    ws.message(eventFrame('s1', 'turn.end', 2, { stop: 'end_turn' }))
    expect(store.peek('s1').snapshot.running).toBe(false)

    // the poll-only totals refresh shortly after the turn end
    await vi.advanceTimersByTimeAsync(300)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/s1/snapshot'))).toBe(true)
  })

  it('recovers a frozen view after the child restarts', async () => {
    store.acquire('s1')
    const ws = openSocket()
    ws.message({ type: 'init', sessionId: 's1', state: snapshotFor('s1'), entries: [] })
    ws.message(eventFrame('s1', 'turn.start', 40, { model: 'old' }))
    expect(store.peek('s1').snapshot.running).toBe(true)

    // the process died and a replacement came up: reconnecting then online
    // arrive with no second init, and the replacement renumbers seq from one
    ws.message({ type: 'child', sessionId: 's1', state: 'reconnecting', detail: 'connection lost' })
    expect(stream.sessionPhase('s1')).toBe('resyncing')
    ws.message({ type: 'child', sessionId: 's1', state: 'online' })
    const syncs = sentFrames(ws).filter((f) => (f as { type: string }).type === 'sync')
    expect(syncs).toEqual([{ type: 'sync', sessionId: 's1' }])

    // the sync answer rebuilds state, so the renumbered stream applies again
    ws.message({ type: 'init', sessionId: 's1', state: snapshotFor('s1'), entries: [] })
    expect(stream.sessionPhase('s1')).toBe('live')
    ws.message(eventFrame('s1', 'turn.start', 1, { model: 'new' }))
    expect(store.peek('s1').snapshot.running).toBe(true)
  })

  it('keeps stream state newer than a stale snapshot read', async () => {
    // The poll's response was read upstream before the dialog opened and lands
    // after its event; the stamp says so, so only poll-only facts merge.
    const snap = { ...snapshotFor('s1'), seq: 3, cwd: '/elsewhere', interactions: [] }
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(Response.json(snap)))
    store.acquire('s1')
    const ws = openSocket()
    ws.message({ type: 'init', sessionId: 's1', state: snapshotFor('s1'), entries: [] })
    ws.message(
      eventFrame('s1', 'interaction.pending', 5, {
        id: 7,
        kind: 'confirm',
        prompt: 'Allow write access?',
      }),
    )
    expect(store.peek('s1').snapshot.interactions).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(21_000) // the resnapshot cadence runs at least once
    expect(store.peek('s1').snapshot.cwd).toBe('/elsewhere')
    expect(store.peek('s1').snapshot.interactions).toHaveLength(1)
  })

  it('drops snapshot reads that raced a stream rebuild', async () => {
    store.acquire('s1')
    const ws = openSocket()
    ws.message({ type: 'init', sessionId: 's1', state: snapshotFor('s1'), entries: [] })

    // Hold the poll's response until a reconnect-style init has rebuilt state.
    let respond!: (res: Response) => void
    vi.mocked(fetch).mockImplementation(
      () => new Promise<Response>((resolve) => (respond = resolve)),
    )
    await vi.advanceTimersByTimeAsync(21_000)
    ws.message({ type: 'init', sessionId: 's1', state: snapshotFor('s1'), entries: [] })

    const stale = Response.json({ ...snapshotFor('s1'), cwd: '/before-the-rebuild' })
    respond(stale)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.peek('s1').snapshot.cwd).toBe('') // the pre-init read never lands
  })

  it('drops a superseded poll after a turn refresh', async () => {
    store.acquire('s1')
    const ws = openSocket()
    ws.message({ type: 'init', sessionId: 's1', state: snapshotFor('s1'), entries: [] })

    const replies = holdFetches()
    await vi.advanceTimersByTimeAsync(20_000) // the interval poll starts first
    ws.message(eventFrame('s1', 'turn.start', 1, { model: 'm' }))
    ws.message(eventFrame('s1', 'turn.end', 2, { stop: 'end_turn' }))
    await vi.advanceTimersByTimeAsync(200) // the post-turn refresh starts second
    expect(replies).toHaveLength(2)

    const afterTurn = {
      ...snapshotFor('s1'),
      cwd: '/after-turn',
      seat: { held: true, holder: 'swarm', yours: true },
    }
    const beforeTurn = {
      ...snapshotFor('s1'),
      seq: 99,
      cwd: '/before-turn',
      seat: { held: false, yours: false },
    }

    // the newer reply lands first with the post-turn facts
    replies[1](Response.json(afterTurn))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.peek('s1').snapshot.cwd).toBe('/after-turn')

    // the older reply lands last; its stamp passes the reducer's freshness
    // gate, so only the ordering guard keeps it from regressing fresher state
    replies[0](Response.json(beforeTurn))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.peek('s1').snapshot.cwd).toBe('/after-turn')
    expect(store.peek('s1').snapshot.seat).toEqual({ held: true, holder: 'swarm', yours: true })
  })

  it('drops a superseded turn refresh after a poll', async () => {
    store.acquire('s1')
    const ws = openSocket()
    ws.message({ type: 'init', sessionId: 's1', state: snapshotFor('s1'), entries: [] })
    ws.message(eventFrame('s1', 'turn.start', 1, { model: 'm' }))
    ws.message(eventFrame('s1', 'turn.end', 2, { stop: 'end_turn' }))

    const replies = holdFetches()
    await vi.advanceTimersByTimeAsync(100) // the post-turn refresh starts first
    await vi.advanceTimersByTimeAsync(20_000) // the interval poll supersedes it
    expect(replies).toHaveLength(2)

    const fromPoll = { ...snapshotFor('s1'), seq: 99, cwd: '/from-poll' }
    const fromTurn = { ...snapshotFor('s1'), seq: 99, cwd: '/from-turn' }

    replies[1](Response.json(fromPoll))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.peek('s1').snapshot.cwd).toBe('/from-poll')

    // the superseded turn refresh resolves last with an equally fresh stamp
    replies[0](Response.json(fromTurn))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.peek('s1').snapshot.cwd).toBe('/from-poll')
  })

  it('applies sequential snapshot replies in order', async () => {
    store.acquire('s1')
    const ws = openSocket()
    ws.message({ type: 'init', sessionId: 's1', state: snapshotFor('s1'), entries: [] })

    const replies = holdFetches()
    await vi.advanceTimersByTimeAsync(20_000) // the interval poll starts and lands
    expect(replies).toHaveLength(1)
    replies[0](Response.json({ ...snapshotFor('s1'), seq: 5, cwd: '/first' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.peek('s1').snapshot.cwd).toBe('/first')

    // a later request that starts after the last one settled still applies:
    // the guard drops only superseded reads, never every overlapping one
    ws.message(eventFrame('s1', 'turn.start', 1, { model: 'm' }))
    ws.message(eventFrame('s1', 'turn.end', 2, { stop: 'end_turn' }))
    await vi.advanceTimersByTimeAsync(200)
    expect(replies).toHaveLength(2)
    replies[1](Response.json({ ...snapshotFor('s1'), seq: 6, cwd: '/second' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.peek('s1').snapshot.cwd).toBe('/second')
  })

  it('signals digest changes only on queue-moving transitions', async () => {
    store.acquire('s1')
    const ws = openSocket()
    ws.message({ type: 'init', sessionId: 's1', state: snapshotFor('s1'), entries: [] })

    const changes: string[] = []
    store.onDigestChange(() => changes.push('digest'))

    // transcript and activity churn never touches the digest facts
    ws.message(eventFrame('s1', 'entry.append', 1, { type: 'text', ts: 1, data: '' }))
    ws.message(eventFrame('s1', 'activity', 2, { rows: [{ label: 'reading main.go' }] }))
    expect(changes).toEqual([])

    // a dialog opening moves the session into the needs queue
    ws.message(
      eventFrame('s1', 'interaction.pending', 3, {
        id: 7,
        kind: 'confirm',
        prompt: 'Allow write access?',
      }),
    )
    expect(changes).toEqual(['digest'])

    // answering it settles the dialog and starts the turn
    ws.message(eventFrame('s1', 'turn.start', 4, { model: 'm' }))
    ws.message(eventFrame('s1', 'interaction.settled', 5, { id: 7, answered: true }))
    expect(changes).toEqual(['digest', 'digest', 'digest'])

    // the turn ending drops the session back out of working
    ws.message(eventFrame('s1', 'turn.end', 6, { stop: 'end_turn' }))
    expect(changes).toHaveLength(4)
  })

  it('drops snapshot reads that raced a session exit', async () => {
    store.acquire('s1')
    const ws = openSocket()
    ws.message({ type: 'init', sessionId: 's1', state: snapshotFor('s1'), entries: [] })
    ws.message(eventFrame('s1', 'turn.start', 1, { model: 'm' }))
    ws.message(eventFrame('s1', 'status', 2, { spinning: true }))

    // Hold the poll's response until the session has exited mid-turn.
    let respond!: (res: Response) => void
    vi.mocked(fetch).mockImplementation(
      () => new Promise<Response>((resolve) => (respond = resolve)),
    )
    await vi.advanceTimersByTimeAsync(21_000)
    ws.message(eventFrame('s1', 'session.exit', 3, { reason: 'sigterm' }))
    // the exit closed the turn itself: no turn.end ever arrives
    expect(store.peek('s1').snapshot.running).toBe(false)
    expect(store.peek('s1').snapshot.spinning).toBe(false)

    // the fleet's final view still carries the busy facts at a fresh stamp;
    // landing it must not resurrect them
    respond(Response.json({ ...snapshotFor('s1'), seq: 3, running: true, spinning: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.peek('s1').snapshot.running).toBe(false)
    expect(store.peek('s1').snapshot.spinning).toBe(false)

    // the turn-end resnapshot the exit scheduled stays settled too
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(Response.json(snapshotFor('s1'))))
    await vi.advanceTimersByTimeAsync(300)
    expect(store.peek('s1').snapshot.spinning).toBe(false)
    expect(store.peek('s1').exitReason).toBe('sigterm')
  })

  it('unsubscribes everything on dispose', async () => {
    for (const id of ['a', 'b', 'c', 'd']) store.acquire(id)()
    const ws = openSocket()
    await vi.advanceTimersByTimeAsync(0)
    expect(sentFrames(ws)).toHaveLength(4)

    store.dispose()
    const unsubs = sentFrames(ws).filter((f) => (f as { type: string }).type === 'unsubscribe')
    expect(unsubs).toHaveLength(4)
  })

  it('stops polling sessions that ended for good', async () => {
    store.acquire('s1')
    const ws = openSocket()
    ws.message({ type: 'init', sessionId: 's1', state: snapshotFor('s1'), entries: [] })
    ws.message({ type: 'child', sessionId: 's1', state: 'exited' })

    const fetchMock = vi.mocked(fetch)
    fetchMock.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/s1/snapshot'))).toBe(false)
  })
})

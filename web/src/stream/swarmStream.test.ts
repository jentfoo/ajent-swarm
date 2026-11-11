import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SwarmStream } from './swarmStream'
import { resubscribeBaseMs, resubscribeMaxMs } from './swarmStream'
import type { ServerFrame } from '../api/types'
import { MockWebSocket } from '../test/mockWebSocket'

function lastSocket(): MockWebSocket {
  const ws = MockWebSocket.instances.at(-1)
  if (!ws) throw new Error('no socket created')
  return ws
}

// subscribe frames the current socket has sent, retries included.
function subscribeCount(): number {
  return lastSocket()
    .sent.map((raw) => JSON.parse(raw as string))
    .filter((f: { type: string }) => f.type === 'subscribe').length
}

const initFrameFor = (sessionId: string): ServerFrame => ({
  type: 'init',
  sessionId,
  state: testSnapshot(sessionId),
  entries: [],
})

function testSnapshot(sessionId: string) {
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
    seat: { held: false, yours: false },
  }
}

describe('SwarmStream subscriptions', () => {
  let stream: SwarmStream

  beforeEach(() => {
    MockWebSocket.instances = []
    vi.useFakeTimers()
    stream = new SwarmStream({
      url: 'ws://swarm/api/stream',
      socketFactory: (url) => new MockWebSocket(url),
      jitter: false,
    })
  })

  afterEach(() => {
    stream.disconnect()
    vi.useRealTimers()
  })

  it('reference counts two views of one session onto one subscription', async () => {
    const got1: ServerFrame[] = []
    const got2: ServerFrame[] = []

    const un1 = stream.subscribe('s1', (f) => got1.push(f))
    await vi.advanceTimersByTimeAsync(0)
    const ws = lastSocket()
    ws.open()

    // The first view joined the wire exactly once.
    expect(ws.sent.map((raw) => JSON.parse(raw))).toEqual([{ type: 'subscribe', sessionId: 's1' }])

    const un2 = stream.subscribe('s1', (f) => got2.push(f))
    expect(ws.sent).toHaveLength(1) // no second subscribe frame

    ws.message(initFrameFor('s1'))
    expect(got1).toHaveLength(1)
    expect(got2).toHaveLength(1)
    expect(stream.sessionPhase('s1')).toBe('live')

    // Leaving one of two views removes its own listener at once: the departed
    // callback goes quiet while the survivor keeps receiving.
    un1()
    ws.message({ type: 'child', sessionId: 's1', state: 'online' })
    expect(got1).toHaveLength(1)
    expect(got2).toHaveLength(2)

    // The last view leaving unsubscribes on the wire and nothing hears frames.
    un2()
    ws.message({ type: 'child', sessionId: 's1', state: 'online' })
    expect(got1).toHaveLength(1)
    expect(got2).toHaveLength(2)
    expect(ws.sent).toHaveLength(2) // the first leave never touched the wire
    expect(JSON.parse(ws.sent[1])).toEqual({ type: 'unsubscribe', sessionId: 's1' })
  })

  it('routes frames per session and keeps phases honest', async () => {
    stream.subscribe('s1', () => {})
    await vi.advanceTimersByTimeAsync(0)
    const ws = lastSocket()
    ws.open()

    ws.message({ type: 'child', sessionId: 's1', state: 'reconnecting', detail: 'connection lost' })
    expect(stream.sessionPhase('s1')).toBe('resyncing')

    ws.message(initFrameFor('s1'))
    expect(stream.sessionPhase('s1')).toBe('live')

    ws.message({ type: 'child', sessionId: 's1', state: 'exited' })
    expect(stream.sessionPhase('s1')).toBe('ended')
  })

  it('resyncs when a redialed child comes online', async () => {
    const got: ServerFrame[] = []
    stream.subscribe('s1', (f) => got.push(f))
    await vi.advanceTimersByTimeAsync(0)
    const ws = lastSocket()
    ws.open()
    ws.message(initFrameFor('s1'))
    expect(stream.sessionPhase('s1')).toBe('live')

    // the process died: the actor redials a replacement that renumbers seq
    // from one, and held subscribers get no second greeting
    ws.message({ type: 'child', sessionId: 's1', state: 'reconnecting', detail: 'connection lost' })
    expect(stream.sessionPhase('s1')).toBe('resyncing')
    ws.message({ type: 'child', sessionId: 's1', state: 'online' })
    expect(JSON.parse(ws.sent[1])).toEqual({ type: 'sync', sessionId: 's1' })

    // the sync answer rebuilds state: watermark and phase reset
    ws.message(initFrameFor('s1'))
    expect(stream.sessionPhase('s1')).toBe('live')
    expect(got.filter((f) => f.type === 'init')).toHaveLength(2)
  })

  it('leaves a greeted view alone when online follows', async () => {
    stream.subscribe('s1', () => {})
    await vi.advanceTimersByTimeAsync(0)
    const ws = lastSocket()
    ws.open()

    // greet order for a fresh join: init first, then online
    ws.message(initFrameFor('s1'))
    ws.message({ type: 'child', sessionId: 's1', state: 'online' })
    expect(stream.sessionPhase('s1')).toBe('live')
    expect(ws.sent).toHaveLength(1) // the join alone, no sync
  })

  it('resyncs when online arrives before the init', async () => {
    stream.subscribe('s1', () => {})
    await vi.advanceTimersByTimeAsync(0)
    const ws = lastSocket()
    ws.open()

    // a greeting the queue lost: online lands with no init behind it
    ws.message({ type: 'child', sessionId: 's1', state: 'online' })
    expect(JSON.parse(ws.sent[1])).toEqual({ type: 'sync', sessionId: 's1' })
  })

  it('retries an unknown session before marking it lost', async () => {
    const unsub = stream.subscribe('nope', () => {})
    await vi.advanceTimersByTimeAsync(0)
    lastSocket().open()

    // the fleet does not track this session yet: subscribe refusals retry on a
    // backoff while any view holds it, staying in connecting (not lost)
    lastSocket().message({ type: 'error', code: 'unknown_session', sessionId: 'nope' })
    expect(stream.sessionPhase('nope')).toBe('connecting')
    await vi.advanceTimersByTimeAsync(500)
    const sent = lastSocket()
      .sent.map((raw) => JSON.parse(raw as string))
      .filter((f: { type: string }) => f.type === 'subscribe')
    expect(sent).toHaveLength(2) // the original plus one retry

    // once the fleet starts tracking it, an init lands and phases go live
    lastSocket().message(initFrameFor('nope'))
    expect(stream.sessionPhase('nope')).toBe('live')

    // exhausted attempts give up as lost for truly absent sessions
    unsub()
    const dead = stream.subscribe('gone', () => {})
    await vi.advanceTimersByTimeAsync(0)
    lastSocket().open()
    for (let i = 0; i < 13; i++) {
      lastSocket().message({ type: 'error', code: 'unknown_session', sessionId: 'gone' })
      await vi.advanceTimersByTimeAsync(resubscribeMaxMs)
    }
    expect(stream.sessionPhase('gone')).toBe('lost')
    dead()
  })

  it('resync sends a sync frame only for subscribed sessions', async () => {
    stream.subscribe('s1', () => {})
    await vi.advanceTimersByTimeAsync(0)
    const ws = lastSocket()
    ws.open()

    stream.resync('s2') // never joined; ignored
    expect(ws.sent).toHaveLength(1)

    stream.resync('s1')
    expect(JSON.parse(ws.sent[1])).toEqual({ type: 'sync', sessionId: 's1' })
  })

  it('retries every subscription-level refusal code', async () => {
    const got: ServerFrame[] = []
    stream.subscribe('s1', (f) => got.push(f))
    await vi.advanceTimersByTimeAsync(0)
    lastSocket().open()

    for (const code of ['unknown_session', 'not_subscribed', 'subscribe_failed']) {
      const before = subscribeCount()
      lastSocket().message({ type: 'error', code, sessionId: 's1' })
      expect(stream.sessionPhase('s1')).toBe('connecting') // waiting out the backoff
      await vi.advanceTimersByTimeAsync(resubscribeMaxMs)
      expect(subscribeCount()).toBe(before + 1) // exactly one retry per refusal
    }

    // refusals still reach listeners, and an init ends the retrying as live
    expect(got.some((f) => f.type === 'error')).toBe(true)
    lastSocket().message(initFrameFor('s1'))
    expect(stream.sessionPhase('s1')).toBe('live')
  })

  it('never retries refusals that name no subscription failure', async () => {
    stream.subscribe('s1', () => {})
    await vi.advanceTimersByTimeAsync(0)
    lastSocket().open()

    lastSocket().message({ type: 'error', code: 'bad_request', sessionId: 's1' })
    expect(stream.sessionPhase('s1')).toBe('connecting')
    await vi.advanceTimersByTimeAsync(resubscribeMaxMs)
    expect(subscribeCount()).toBe(1) // only the original join
  })

  it('gives a reopened view a fresh retry budget', async () => {
    const unsub = stream.subscribe('gone', () => {})
    await vi.advanceTimersByTimeAsync(0)
    lastSocket().open()
    for (let i = 0; i < 13; i++) {
      lastSocket().message({ type: 'error', code: 'unknown_session', sessionId: 'gone' })
      await vi.advanceTimersByTimeAsync(resubscribeMaxMs)
    }
    expect(stream.sessionPhase('gone')).toBe('lost')
    const exhausted = subscribeCount()

    // closing and reopening the view clears the spent budget, so the first
    // refusal retries instead of re-marking lost with zero attempts
    unsub()
    stream.subscribe('gone', () => {})
    lastSocket().message({ type: 'error', code: 'unknown_session', sessionId: 'gone' })
    await vi.advanceTimersByTimeAsync(resubscribeBaseMs)
    expect(stream.sessionPhase('gone')).toBe('connecting')
    expect(subscribeCount()).toBe(exhausted + 2) // the reopened join plus one retry

    lastSocket().message(initFrameFor('gone'))
    expect(stream.sessionPhase('gone')).toBe('live')
  })
})

describe('SwarmStream reconnects', () => {
  let stream: SwarmStream

  beforeEach(() => {
    MockWebSocket.instances = []
    vi.useFakeTimers()
    stream = new SwarmStream({
      url: 'ws://swarm/api/stream',
      socketFactory: (url) => new MockWebSocket(url),
      jitter: false,
      backoffBaseMs: 100,
      backoffMaxMs: 800,
      staleAfterMs: 4000, // watchdog checks every ~1.3s in these tests
    })
  })

  afterEach(() => {
    stream.disconnect()
    vi.useRealTimers()
  })

  it('connects eagerly without a subscription and retries the drop', async () => {
    stream.connect()
    await vi.advanceTimersByTimeAsync(0)
    const ws = lastSocket()
    expect(ws.sent).toEqual([]) // nobody has joined yet; the socket idles open
    ws.open()
    expect(stream.connectionState()).toBe('open')

    // The idle connection still gets the backoff retry loop.
    ws.close()
    await vi.advanceTimersByTimeAsync(100)
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('rejoins every refd session after a drop with fresh init expected', async () => {
    const connChanges: string[] = []
    stream.onConnectionChange(() => connChanges.push(stream.connectionState()))

    stream.subscribe('s1', () => {})
    await vi.advanceTimersByTimeAsync(0)
    const first = lastSocket()
    first.open()

    first.close()
    await vi.advanceTimersByTimeAsync(0)
    expect(connChanges).toContain('closed')
    expect(stream.sessionPhase('s1')).toBe('resyncing') // state held, init pending

    // Exponential backoff: the retry lands 100ms after the drop.
    const before = MockWebSocket.instances.length
    await vi.advanceTimersByTimeAsync(100)
    expect(MockWebSocket.instances).toHaveLength(before + 1)
    const second = lastSocket()
    second.open()
    expect(JSON.parse(second.sent[0])).toEqual({ type: 'subscribe', sessionId: 's1' })
    expect(stream.connectionState()).toBe('open')

    // A fresh init rebuilds state and returns to live.
    second.message(initFrameFor('s1'))
    expect(stream.sessionPhase('s1')).toBe('live')
  })

  it('caps the backoff at the maximum', async () => {
    stream.subscribe('s1', () => {})
    await vi.advanceTimersByTimeAsync(0)
    lastSocket().open()

    const waits: number[] = []
    for (let round = 0; round < 5; round++) {
      lastSocket().close()
      await vi.advanceTimersByTimeAsync(0) // deliver the close event

      const before = MockWebSocket.instances.length
      let elapsed = 0
      while (MockWebSocket.instances.length === before && elapsed <= 2000) {
        await vi.advanceTimersByTimeAsync(50)
        elapsed += 50
      }
      waits.push(elapsed)
    }
    expect(waits).toEqual([100, 200, 400, 800, 800])
  })

  it('reconnects immediately when the tab becomes visible', async () => {
    stream.subscribe('s1', () => {})
    await vi.advanceTimersByTimeAsync(0)
    const first = lastSocket()
    first.open()
    first.close()
    await vi.advanceTimersByTimeAsync(0)

    expect(MockWebSocket.instances).toHaveLength(1) // still backing off
    document.dispatchEvent(new Event('visibilitychange'))
    const second = lastSocket()
    expect(MockWebSocket.instances).toHaveLength(2)
    second.open()
    expect(JSON.parse(second.sent[0])).toEqual({ type: 'subscribe', sessionId: 's1' })

    // While connected, visibility triggers a resync instead of a reconnect.
    document.dispatchEvent(new Event('visibilitychange'))
    expect(JSON.parse(second.sent[1])).toEqual({ type: 'sync', sessionId: 's1' })
  })

  it('closes a socket that stops heartbeating', async () => {
    stream.subscribe('s1', () => {})
    await vi.advanceTimersByTimeAsync(0)
    const ws = lastSocket()
    ws.open()

    // Nothing arrives past the open, the watchdog gives up on the socket.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(ws.readyState).toBe(3)
  })

  it('keeps the socket open when heartbeats keep flowing', async () => {
    stream.subscribe('s1', () => {})
    await vi.advanceTimersByTimeAsync(0)
    const ws = lastSocket()
    ws.open()

    for (let i = 0; i < 10; i++) {
      ws.message({ type: 'heartbeat' })
      await vi.advanceTimersByTimeAsync(1000) // well under the stale window
    }
    expect(ws.readyState).toBe(1)
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('keeps an ended session off the wire across a reconnect', async () => {
    stream.subscribe('s1', () => {})
    await vi.advanceTimersByTimeAsync(0)
    const first = lastSocket()
    first.open()
    first.message(initFrameFor('s1'))
    first.message({ type: 'child', sessionId: 's1', state: 'exited' })
    expect(stream.sessionPhase('s1')).toBe('ended')

    // the visibility resync skips a finished session too
    document.dispatchEvent(new Event('visibilitychange'))
    expect(first.sent.some((raw) => JSON.parse(raw).type === 'sync')).toBe(false)

    first.close()
    await vi.advanceTimersByTimeAsync(0)
    expect(stream.sessionPhase('s1')).toBe('ended') // no resyncing regression

    await vi.advanceTimersByTimeAsync(100) // the reconnect lands
    const second = lastSocket()
    expect(second).not.toBe(first)
    second.open()
    expect(second.sent).toEqual([]) // a definitive end never rejoins
  })
})

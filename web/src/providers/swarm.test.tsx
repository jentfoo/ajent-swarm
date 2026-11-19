import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SwarmProvider, useSwarm } from './swarm'
import { MockWebSocket } from '../test/mockWebSocket'
import { ctlSnapshot } from '../test/ctlSnapshot'
import type { AttentionRow, ServerFrame, SessionStatus } from '../api/types'
import type { SocketState } from '../stream/swarmStream'

// The provider keeps the focus-queue digest in step with the stream: a frame
// that moves a session between queues (a dialog opening or settling, a turn
// boundary) refreshes the digest out of band instead of waiting out the poll
// cadence the rail would otherwise re-sort behind.

// Probe acquires one session so its frames land in the store, like a mounted
// chat view would, and records the digest consumers read.
let seenAttention: AttentionRow[] = []

function Probe({ sessionId }: { sessionId: string }) {
  const { store, attention } = useSwarm()
  useEffect(() => store.acquire(sessionId), [store, sessionId])
  useEffect(() => {
    seenAttention = attention
  }, [attention])
  return null
}

// lastSocket grabs the newest mock connection, each mounted provider owns one.
function lastSocket(): MockWebSocket {
  const ws = MockWebSocket.instances.at(-1)
  if (!ws) throw new Error('no socket created')
  return ws
}

describe('SwarmProvider digest sync', () => {
  let attentionFetches: number
  let attentionRows: AttentionRow[]

  beforeEach(() => {
    vi.useFakeTimers()
    attentionFetches = 0
    attentionRows = []
    seenAttention = []
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', class extends MockWebSocket {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const path = String(url)
          .replace(/^https?:\/\/[^/]+/, '')
          .split('?')[0]
        if (path === '/api/attention') {
          attentionFetches += 1
          return Response.json(attentionRows)
        }
        if (path === '/api/sessions') return Response.json([])
        const snap = /\/api\/sessions\/([^/]+)\/snapshot/.exec(path)
        if (snap) return Response.json(ctlSnapshot(snap[1]))
        throw new Error(`unexpected fetch ${path}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function openSocket(): MockWebSocket {
    const ws = lastSocket()
    act(() => ws.open())
    return ws
  }

  it('refreshes the digest when a frame moves a session between queues', async () => {
    render(
      <SwarmProvider>
        <Probe sessionId="s1" />
      </SwarmProvider>,
    )
    const ws = openSocket()
    ws.message({ type: 'init', sessionId: 's1', state: ctlSnapshot('s1'), entries: [] })

    // mount tick only: no frame has moved anything yet
    expect(attentionFetches).toBe(1)

    const dialogFrame: ServerFrame = {
      type: 'event',
      sessionId: 's1',
      event: {
        event: 'interaction.pending',
        seq: 2,
        data: { id: 7, kind: 'confirm', prompt: 'Allow write access?' },
      },
    }
    act(() => ws.message(dialogFrame))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })

    // the dialog frame drove one out-of-band digest fetch
    expect(attentionFetches).toBe(2)
  })

  it('lands the refreshed rows in the context consumers read', async () => {
    attentionRows = [
      {
        sessionId: 's1',
        openInteractions: 1,
        running: false,
        idle: false,
        kind: 'needs-input',
        reason: 'Allow write access?',
      },
    ]
    render(
      <SwarmProvider>
        <Probe sessionId="s1" />
      </SwarmProvider>,
    )
    const ws = openSocket()
    ws.message({ type: 'init', sessionId: 's1', state: ctlSnapshot('s1'), entries: [] })
    expect(seenAttention).toEqual([])

    ws.message({
      type: 'event',
      sessionId: 's1',
      event: {
        event: 'interaction.pending',
        seq: 2,
        data: { id: 7, kind: 'confirm', prompt: 'Allow write access?' },
      },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })

    // the out-of-band fetch's rows reach useSwarm readers in the same pass
    expect(seenAttention).toEqual(attentionRows)
  })

  it('leaves transcript churn on the poll cadence', async () => {
    render(
      <SwarmProvider>
        <Probe sessionId="s1" />
      </SwarmProvider>,
    )
    const ws = openSocket()
    ws.message({ type: 'init', sessionId: 's1', state: ctlSnapshot('s1'), entries: [] })

    act(() => {
      ws.message({
        type: 'event',
        sessionId: 's1',
        event: { event: 'entry.append', seq: 2, data: { type: 'text', ts: 1, data: '' } },
      })
      ws.message({
        type: 'event',
        sessionId: 's1',
        event: { event: 'activity', seq: 3, data: { rows: [{ label: 'reading main.go' }] } },
      })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150)
    })

    // still just the mount tick, only the poll owns these
    expect(attentionFetches).toBe(1)
  })
})

describe('SwarmProvider stale poll guards', () => {
  // Deferred replies let tests land them out of order, like two overlapping
  // GETs resolving backwards on a slow link.
  const parkedSessions: Array<(rows: SessionStatus[]) => void> = []
  const parkedAttention: Array<(rows: AttentionRow[]) => void> = []

  beforeEach(() => {
    MockWebSocket.instances = []
    parkedSessions.length = 0
    parkedAttention.length = 0
    vi.stubGlobal('WebSocket', class extends MockWebSocket {})
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const path = String(url)
          .replace(/^https?:\/\/[^/]+/, '')
          .split('?')[0]
        if (path === '/api/sessions') {
          return new Promise<Response>((resolve) => {
            parkedSessions.push((rows) => resolve(Response.json(rows)))
          })
        }
        if (path === '/api/attention') {
          return new Promise<Response>((resolve) => {
            parkedAttention.push((rows) => resolve(Response.json(rows)))
          })
        }
        throw new Error(`unexpected fetch ${path}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Probe records the committed context and hands the refreshers over, so
  // tests can force overlapping polls without waiting out a cadence.
  let latestCtx: ReturnType<typeof useSwarm>

  function PollProbe() {
    const ctx = useSwarm()
    useEffect(() => {
      latestCtx = ctx
    })
    return null
  }

  function sessionRow(id: string): SessionStatus {
    return {
      sessionId: id,
      state: 'online',
      seatHeld: false,
      seatOurs: false,
      running: false,
      idle: true,
      queued: 0,
      openInteractions: 0,
      spawnedBy: 'swarm',
    }
  }

  it('commits only the newest sessions reply', async () => {
    render(
      <SwarmProvider>
        <PollProbe />
      </SwarmProvider>,
    )

    // the mount poll parks its reply, two forced refreshes overlap it
    expect(parkedSessions).toHaveLength(1)
    await act(async () => {
      void latestCtx.refreshSessions()
      void latestCtx.refreshSessions()
    })
    expect(parkedSessions).toHaveLength(3)

    const fresh = [sessionRow('s2')]
    const stale = [sessionRow('s1'), sessionRow('s0')]

    // the newest reply commits, then the older poll's late reply drops
    await act(async () => {
      parkedSessions[2](fresh)
    })
    expect(latestCtx.sessions).toEqual(fresh)

    await act(async () => {
      parkedSessions[1](stale)
    })
    expect(latestCtx.sessions).toEqual(fresh)
  })

  it('commits only the newest attention reply', async () => {
    render(
      <SwarmProvider>
        <PollProbe />
      </SwarmProvider>,
    )

    // the mount poll parks its reply, two forced refreshes overlap it
    expect(parkedAttention).toHaveLength(1)
    await act(async () => {
      void latestCtx.refreshAttention()
      void latestCtx.refreshAttention()
    })
    expect(parkedAttention).toHaveLength(3)

    const fresh: AttentionRow[] = [
      { sessionId: 's2', openInteractions: 1, running: false, idle: false, kind: 'needs-input' },
    ]

    // the newest reply commits, then the older poll's late reply drops
    await act(async () => {
      parkedAttention[2](fresh)
    })
    expect(latestCtx.attention).toEqual(fresh)

    await act(async () => {
      parkedAttention[1]([])
    })
    expect(latestCtx.attention).toEqual(fresh)
  })

  it('latches loaded on first roster', async () => {
    render(
      <SwarmProvider>
        <PollProbe />
      </SwarmProvider>,
    )
    // an unpolled roster and a committed empty one must stay tellable apart
    expect(latestCtx.sessionsLoaded).toBe(false)

    await act(async () => {
      parkedSessions[0]([])
    })
    expect(latestCtx.sessionsLoaded).toBe(true)
  })
})

describe('SwarmProvider roster tracking', () => {
  // The store tracks every live roster session so attention frames land with
  // no view mounted. Ended rows carry no actor behind them: subscribing buys
  // a refusal loop, so tracking keeps to rows that can still serve frames.
  let roster: SessionStatus[]

  beforeEach(() => {
    vi.useFakeTimers()
    roster = []
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', class extends MockWebSocket {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const path = String(url).split('?')[0]
        if (path === '/api/sessions') return Response.json(roster)
        if (path === '/api/attention') return Response.json([])
        throw new Error(`unexpected fetch ${path}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function row(id: string, state: SessionStatus['state']): SessionStatus {
    return {
      sessionId: id,
      state,
      seatHeld: false,
      seatOurs: false,
      running: false,
      idle: true,
      queued: 0,
      openInteractions: 0,
      spawnedBy: 'swarm',
    }
  }

  // ids sent for one frame type, in order
  function sentIds(type: string): string[] {
    return lastSocket()
      .sent.map((raw) => JSON.parse(raw) as { type: string; sessionId: string })
      .filter((f) => f.type === type)
      .map((f) => f.sessionId)
  }

  it('tracks only live rows and heals a relaunch of the same id', async () => {
    roster = [row('live', 'online'), row('dead', 'exited')]
    render(<SwarmProvider>{null}</SwarmProvider>)
    const ws = lastSocket()
    act(() => ws.open())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // the exited row serves no frames, only the live one joins the stream
    expect(sentIds('subscribe')).toEqual(['live'])

    // the live row exits, the dead one relaunches: tracking follows both, so
    // the relaunch starts from a fresh subscribe, not a burnt retry budget
    roster = [row('live', 'exited'), row('dead', 'online')]
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(sentIds('unsubscribe')).toEqual(['live'])
    expect(sentIds('subscribe')).toEqual(['live', 'dead'])
  })
})

describe('SwarmProvider connection state', () => {
  // Records each committed value, exactly what the banner renders.
  let seen: SocketState[] = []

  function ConnProbe() {
    const { connection } = useSwarm()
    useEffect(() => {
      seen.push(connection)
    })
    return null
  }

  beforeEach(() => {
    vi.useFakeTimers()
    seen = []
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', class extends MockWebSocket {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([])),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('claims connecting at first paint', () => {
    render(
      <SwarmProvider>
        <ConnProbe />
      </SwarmProvider>,
    )

    // mount effects run before connect(), the very first read is the init
    expect(seen[0]).toBe('connecting')
  })

  it('follows the stream through open and a drop', async () => {
    render(
      <SwarmProvider>
        <ConnProbe />
      </SwarmProvider>,
    )

    const ws = lastSocket()
    act(() => ws.open())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(seen.at(-1)).toBe('open')

    // A drop lands as closed, the lost banner's cue. Zero advance keeps the
    // scheduled reconnect from firing.
    act(() => ws.close())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(seen.at(-1)).toBe('closed')
  })
})

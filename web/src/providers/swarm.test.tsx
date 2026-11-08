import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SwarmProvider, useSwarm } from './swarm'
import { MockWebSocket } from '../test/mockWebSocket'
import type { AttentionRow, ServerFrame, SessionStatus } from '../api/types'

// The provider keeps the focus-queue digest in step with the stream: a frame
// that moves a session between queues (a dialog opening or settling, a turn
// boundary) refreshes the digest out of band instead of waiting out the poll
// cadence the rail would otherwise re-sort behind.
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
        if (snap) return Response.json(snapshotFor(snap[1]))
        throw new Error(`unexpected fetch ${path}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function openSocket(): MockWebSocket {
    const ws = MockWebSocket.instances.at(-1)
    if (!ws) throw new Error('no socket created')
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
    ws.message({ type: 'init', sessionId: 's1', state: snapshotFor('s1'), entries: [] })

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
    ws.message({ type: 'init', sessionId: 's1', state: snapshotFor('s1'), entries: [] })
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
    ws.message({ type: 'init', sessionId: 's1', state: snapshotFor('s1'), entries: [] })

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

    // still just the mount tick; only the poll owns these
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

    // the mount poll parks its reply; two forced refreshes overlap it
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

    // the mount poll parks its reply; two forced refreshes overlap it
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
})

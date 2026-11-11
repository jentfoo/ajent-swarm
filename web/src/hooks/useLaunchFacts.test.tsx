import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLaunchFacts } from './useLaunchFacts'
import { SwarmProvider } from '../providers/swarm'
import { MockWebSocket } from '../test/mockWebSocket'

// The launch-facts hook under the real provider stack with fetch stubs shaped
// like the Go handlers answer: workspaces union live before saved keeping
// first sight, and refused reads leave that section empty instead of throwing.
describe('useLaunchFacts', () => {
  let sockets: MockWebSocket[]

  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal(
      'WebSocket',
      class extends MockWebSocket {
        constructor(url: string) {
          super(url)
          sockets.push(this)
        }
      },
    )
    sockets = []
  })

  afterEach(() => {
    sockets = []
    vi.unstubAllGlobals()
  })

  function renderFacts() {
    return renderHook(() => useLaunchFacts(), {
      wrapper: ({ children }) => <SwarmProvider>{children}</SwarmProvider>,
    })
  }

  it('unions workspaces live before saved keeping first sight', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const path = String(url).split('?')[0]
        if (path === '/api/sessions') {
          return Response.json([
            { sessionId: '01A', state: 'online', workspace: '/live/one' },
            { sessionId: '01B', state: 'online', workspace: '/live/two' },
          ])
        }
        if (path === '/api/saved-sessions') {
          return Response.json([
            { id: '02A', target: '02A', workspace: '/saved/three' },
            // a saved row revisiting a live workspace must not duplicate it
            { id: '02B', target: '02B', workspace: '/live/one' },
          ])
        }
        if (path === '/api/models/options') return Response.json([])
        if (path === '/api/attention') return Response.json([])
        throw new Error(`unexpected fetch ${String(url)}`)
      }),
    )

    const { result } = renderFacts()

    await waitFor(() => expect(result.current.saved).toHaveLength(2))
    expect(result.current.workspaceOptions).toEqual(['/live/one', '/live/two', '/saved/three'])
  })

  it('survives refused listings beside live workspaces', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const path = String(url).split('?')[0]
        if (path === '/api/models/options' || path === '/api/saved-sessions') {
          return Response.json({ error: 'internal_error' }, { status: 500 })
        }
        if (path === '/api/sessions') {
          return Response.json([{ sessionId: '01A', state: 'online', workspace: '/live/one' }])
        }
        if (path === '/api/attention') return Response.json([])
        throw new Error(`unexpected fetch ${String(url)}`)
      }),
    )

    const { result } = renderFacts()

    await waitFor(() => expect(result.current.workspaceOptions).toEqual(['/live/one']))
    expect(result.current.models).toEqual([])
    expect(result.current.saved).toEqual([])
  })

  it('replaces saved rows on refresh', async () => {
    let recorded = [{ id: '02A', target: '02A', workspace: '/saved/three' }]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const path = String(url).split('?')[0]
        if (path === '/api/saved-sessions') return Response.json(recorded)
        if (path === '/api/models/options' || path === '/api/attention') return Response.json([])
        if (path === '/api/sessions') return Response.json([])
        throw new Error(`unexpected fetch ${String(url)}`)
      }),
    )

    const { result } = renderFacts()
    await waitFor(() => expect(result.current.saved).toHaveLength(1))

    // a later recording only reaches the listing through an explicit refresh
    recorded = [{ id: '02B', target: '02B', workspace: '/saved/four' }]
    await act(async () => result.current.refreshSaved())

    expect(result.current.saved).toEqual([{ id: '02B', target: '02B', workspace: '/saved/four' }])
  })

  it('keeps saved rows over a refused refresh', async () => {
    let refuse = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const path = String(url).split('?')[0]
        if (path === '/api/saved-sessions') {
          return refuse
            ? Response.json({ error: 'internal_error' }, { status: 500 })
            : Response.json([{ id: '02A', target: '02A', workspace: '/saved/three' }])
        }
        if (path === '/api/models/options' || path === '/api/attention') return Response.json([])
        if (path === '/api/sessions') return Response.json([])
        throw new Error(`unexpected fetch ${String(url)}`)
      }),
    )

    const { result } = renderFacts()
    await waitFor(() => expect(result.current.saved).toHaveLength(1))

    refuse = true
    await act(async () => result.current.refreshSaved())

    // the stale rows stay until a later pull or remount retries the read
    expect(result.current.saved).toEqual([{ id: '02A', target: '02A', workspace: '/saved/three' }])
  })
})

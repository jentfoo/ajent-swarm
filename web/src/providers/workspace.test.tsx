import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceProvider, useWorkspace } from './workspace'
import { AuthProvider } from './auth'
import { SwarmProvider, useSwarm } from './swarm'
import type { AttentionRow } from '../api/types'

// The acknowledgment wiring at the wire boundary: a dialog acknowledgment
// names the digest row that actually holds the dialog being settled, so twin
// instances of one session settle their own rows everywhere.

function digestRow(overrides: Partial<AttentionRow> & { sessionId: string }): AttentionRow {
  return {
    openInteractions: 0,
    running: false,
    idle: true,
    kind: 'awaiting',
    ...overrides,
  }
}

// AckProbe hands the provider's dialog acknowledgment over, so tests post one
// like an answered dialog does without mounting a session surface.
let ackDialog: (sessionId: string, dialogId: number) => void = () => {
  throw new Error('provider not mounted')
}

function AckProbe() {
  const { acknowledgeDialog } = useWorkspace()
  useEffect(() => {
    ackDialog = acknowledgeDialog
  }, [acknowledgeDialog])
  return null
}

// postLikeDialog answers one dialog the way SessionView and its mobile twin do.
async function postLikeDialog(sessionId: string, dialogId: number) {
  await act(async () => {
    ackDialog(sessionId, dialogId)
  })
}

describe('WorkspaceProvider acknowledgments', () => {
  let attention: AttentionRow[]
  const ackBodies: string[] = []

  beforeEach(() => {
    ackBodies.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const path = String(url).split('?')[0]
        if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        if (path === '/api/sessions') return Response.json([])
        if (path === '/api/attention') return Response.json(attention)
        if (path === '/api/attention/ack') {
          ackBodies.push(String(init?.body))
          return new Response(null, { status: 204 })
        }
        throw new Error(`unexpected fetch ${path}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function renderProvider() {
    render(
      <MemoryRouter>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <AckProbe />
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    await act(async () => {}) // settle the mount fetches, the digest is in
  }

  it('settles the twin instance holding the dialog', async () => {
    attention = [
      digestRow({
        sessionId: 'twin',
        pid: 101,
        openInteractions: 1,
        kind: 'needs-input',
        reason: 'allow write?',
        dialogId: 3,
      }),
      digestRow({
        sessionId: 'twin',
        pid: 202,
        openInteractions: 1,
        kind: 'needs-input',
        reason: 'deploy now?',
        dialogId: 7,
      }),
    ]
    await renderProvider()

    // answering either twin names its own row, never whichever digest row
    // comes first
    await postLikeDialog('twin', 7)
    await postLikeDialog('twin', 3)
    await vi.waitFor(() => {
      expect(ackBodies).toEqual([
        '{"sessionId":"twin","pid":202,"dialogId":7}',
        '{"sessionId":"twin","pid":101,"dialogId":3}',
      ])
    })
  })

  it('stands in the first row while the digest lags', async () => {
    attention = [
      digestRow({ sessionId: 'twin', pid: 101 }),
      digestRow({
        sessionId: 'twin',
        pid: 202,
        running: true,
        idle: false,
        kind: 'working',
        reason: 'reading main.go',
      }),
    ]
    await renderProvider()

    // no row names this dialog yet, the session's first row keeps today's
    // single-instance behavior instead of posting nothing at all
    await postLikeDialog('twin', 9)
    await vi.waitFor(() => {
      expect(ackBodies).toEqual(['{"sessionId":"twin","pid":101,"dialogId":9}'])
    })
  })

  it('posts without a pid once no digest row remains', async () => {
    attention = []
    await renderProvider()

    // a session that ended between answer and refresh still acknowledges, the
    // ledger keeps it and nothing re-raises later
    await postLikeDialog('ended', 5)
    await vi.waitFor(() => {
      expect(ackBodies).toEqual(['{"sessionId":"ended","dialogId":5}'])
    })
  })
})

// NoticeProbe hands the digest refresh over and records the in-app count,
// which stays live while the tab title dwells.
let refreshDigest: () => Promise<void> = () => Promise.resolve()
let liveCounts: number[] = []

function NoticeProbe() {
  const { refreshAttention } = useSwarm()
  const { needsInputCount } = useWorkspace()
  useEffect(() => {
    refreshDigest = refreshAttention
  }, [refreshAttention])
  liveCounts.push(needsInputCount)
  return null
}

describe('WorkspaceProvider notice dwell', () => {
  let attention: AttentionRow[]

  beforeEach(() => {
    liveCounts = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const path = String(url).split('?')[0]
        if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        if (path === '/api/sessions') return Response.json([])
        if (path === '/api/attention') return Response.json(attention)
        throw new Error(`unexpected fetch ${path}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function renderNotices() {
    render(
      <MemoryRouter>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <NoticeProbe />
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    await act(async () => {})
  }

  function dialog(since: number): AttentionRow {
    return digestRow({
      sessionId: 's1',
      openInteractions: 1,
      kind: 'needs-input',
      reason: 'allow write?',
      dialogId: 3,
      since,
    })
  }

  it('delays the tab notice while in-app counts stay live', async () => {
    attention = [dialog(Date.now() - 1_000)]
    await renderNotices()

    // the dialog is one second old: the tab stays quiet, the rail counts it
    expect(document.title).toBe('ajent-swarm')
    expect(liveCounts.at(-1)).toBe(1)

    // the same digest read seconds later raises the tab notice
    attention = [dialog(Date.now() - 10_000)]
    await act(async () => {
      await refreshDigest()
    })
    expect(document.title).toBe('(1) ajent-swarm')

    // a further digest keeps it raised while the dialog stays open
    await act(async () => {
      await refreshDigest()
    })
    expect(document.title).toBe('(1) ajent-swarm')
  })

  it('drops the tab notice once the dialog settles', async () => {
    attention = [dialog(Date.now() - 10_000)]
    await renderNotices()
    expect(document.title).toBe('(1) ajent-swarm')

    attention = [digestRow({ sessionId: 's1', kind: 'awaiting' })]
    await act(async () => {
      await refreshDigest()
    })
    expect(document.title).toBe('ajent-swarm')
  })
})

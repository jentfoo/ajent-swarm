import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router'
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

// SessionRouteProbe records the session id a notice navigation landed on.
let locationProbe = ''

function SessionRouteProbe() {
  const { sessionId = '' } = useParams()
  useEffect(() => {
    locationProbe = sessionId
  }, [sessionId])
  return null
}

// NoticeProbe hands the digest refresh over and records the in-app count
// beside the title's gated one, which stays quiet while the rail counts live.
let refreshDigest: () => Promise<void> = () => Promise.resolve()
let liveCounts: number[] = []
let titleCounts: number[] = []

function NoticeProbe() {
  const { refreshAttention } = useSwarm()
  const { needsInputCount, titleCount } = useWorkspace()
  useEffect(() => {
    refreshDigest = refreshAttention
  }, [refreshAttention])
  liveCounts.push(needsInputCount)
  titleCounts.push(titleCount)
  return null
}

describe('WorkspaceProvider notice dwell', () => {
  let attention: AttentionRow[]

  beforeEach(() => {
    liveCounts = []
    titleCounts = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const path = String(url).split('?')[0]
        if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        if (path === '/api/sessions') return Response.json([])
        if (path === '/api/attention') return Response.json(attention)
        if (path === '/api/chains') return Response.json([])
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

    // the dialog is one second old: the title count stays quiet, the rail
    // counts it
    expect(titleCounts.at(-1)).toBe(0)
    expect(liveCounts.at(-1)).toBe(1)

    // the same digest read seconds later raises the tab notice
    attention = [dialog(Date.now() - 10_000)]
    await act(async () => {
      await refreshDigest()
    })
    expect(titleCounts.at(-1)).toBe(1)

    // a further digest keeps it raised while the dialog stays open
    await act(async () => {
      await refreshDigest()
    })
    expect(titleCounts.at(-1)).toBe(1)
  })

  it('drops the tab notice once the dialog settles', async () => {
    attention = [dialog(Date.now() - 10_000)]
    await renderNotices()
    expect(titleCounts.at(-1)).toBe(1)

    attention = [digestRow({ sessionId: 's1', kind: 'awaiting' })]
    await act(async () => {
      await refreshDigest()
    })
    expect(titleCounts.at(-1)).toBe(0)
  })
})

// One failed chain announces through the notification bridge: the digest's
// fresh failure marker on the child row raises one keyed notice naming both
// sessions, its click opens the child, and later digests never re-announce.
class StubNotification {
  static permission = 'granted'
  closed = false
  onclick: ((ev: Event) => void) | null = null
  constructor(
    public title: string,
    public options: { body?: string; tag?: string },
  ) {
    chainNotices.push(this)
  }
  close() {
    this.closed = true
  }
}

let chainNotices: StubNotification[]

describe('WorkspaceProvider chain failure notices', () => {
  let attention: AttentionRow[]

  beforeEach(() => {
    chainNotices = []
    attention = []
    vi.stubGlobal('Notification', StubNotification)
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const path = String(url).split('?')[0]
        if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        if (path === '/api/sessions')
          return Response.json([
            { sessionId: '01CHILD0000000000B', name: 'deploy', state: 'online' },
            { sessionId: '01PARENT0000000000A', name: 'build', state: 'online' },
          ])
        if (path === '/api/attention') return Response.json(attention)
        if (path === '/api/chains') return Response.json([])
        throw new Error(`unexpected fetch ${path}`)
      }),
    )
  })

  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    })
    vi.unstubAllGlobals()
  })

  function failedChainRow(): AttentionRow {
    return digestRow({
      sessionId: '01CHILD0000000000B',
      kind: 'awaiting',
      reason: 'waiting for a prompt',
      chainFailure: 'parent exited',
      chainedOnId: 'chn_1',
      chainedOn: '01PARENT0000000000A',
    })
  }

  async function renderNotices() {
    render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <NoticeProbe />
              <Routes>
                <Route path="/" element={null} />
                <Route path="/s/:sessionId" element={<SessionRouteProbe />} />
              </Routes>
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    await act(async () => {})
  }

  it('raises once and opens the child on click', async () => {
    attention = [failedChainRow()]
    await renderNotices()

    await vi.waitFor(() => expect(chainNotices).toHaveLength(1))
    expect(chainNotices[0].title).toBe('Chain into deploy failed')
    expect(chainNotices[0].options.body).toBe('build → deploy: parent exited')
    expect(chainNotices[0].options.tag).toBe('chain-chn_1')

    // a further digest carrying the same fresh failure never re-announces
    await act(async () => {
      await refreshDigest()
    })
    expect(chainNotices).toHaveLength(1)

    chainNotices[0].onclick?.(new Event('click'))
    await act(async () => {})
    expect(locationProbe).toBe('01CHILD0000000000B')
  })

  it('stays quiet while the digest carries no failure marker', async () => {
    attention = [
      digestRow({
        sessionId: '01CHILD0000000000B',
        kind: 'awaiting',
        reason: 'waiting for a prompt',
        chainedOnId: 'chn_1',
        chainedOn: '01PARENT0000000000A',
      }),
    ]
    await renderNotices()
    await act(async () => {
      await refreshDigest()
    })
    expect(chainNotices).toHaveLength(0)
  })
})

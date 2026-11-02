import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SessionView from './SessionView'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { MockWebSocket } from '../test/mockWebSocket'

// The backend round trip runs against fetch mocks shaped exactly like the Go
// handlers answer; the stream rides a mock WebSocket through the real client.
// This exercises provider, channel hook and applier end to end.

class FetchRouter {
  handler = vi.fn((url: string | URL, _init?: RequestInit): Response => {
    const key = String(url)
      .replace(/^https?:\/\/[^/]+/, '')
      .split('?')[0]
    const respond = this.routes.get(key)
    if (!respond) throw new Error(`unexpected fetch ${String(url)}`)
    return respond()
  })

  private routes = new Map<string, () => Response>()

  on(url: string, respond: () => Response): this {
    this.routes.set(url, respond)
    return this
  }
}

function snapshotFor(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    session: { id: sessionId },
    workspace: '/home/you/project',
    cwd: '/home/you/project',
    head: '',
    model: {
      key: 'anthropic/claude-sonnet',
      short: 'sonnet',
      window: 200_000,
      caps: { reasoning: true, images: false, parallelToolCalls: true },
    },
    permission: 'auto',
    tools: [],
    usage: {
      turns: 2,
      total: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      child: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      estimatedTurns: 0,
    },
    context: {
      used: 40_000,
      window: 200_000,
      reserve: 20_000,
      compact: 150_000,
      estimated: false,
    },
    running: false,
    idle: true,
    spinning: false,
    queued: 0,
    queuedRows: [],
    activity: [],
    status: { segments: [] },
    seat: { held: true, holder: 'swarm', yours: false },
    ...overrides,
  }
}

function messageEntry(id: string, parent: string | undefined, role: string, text: string) {
  const e: Record<string, unknown> = { id, type: 'message', ts: 1 }
  if (parent !== undefined) e.parentId = parent
  e.data = JSON.parse(
    `{"message":{"role":"${role}","content":[{"type":"text","data":{"text":${JSON.stringify(text)}}}]}}`,
  )
  return e
}

function frame(ws: MockWebSocket, payload: unknown) {
  act(() => ws.message(payload))
}

describe('SessionView', () => {
  let fetcher: FetchRouter
  const sockets: MockWebSocket[] = []

  beforeEach(() => {
    vi.stubGlobal(
      'WebSocket',
      class extends MockWebSocket {
        constructor(url: string) {
          super(url)
          sockets.push(this)
        }
      },
    )
    fetcher = new FetchRouter()
    fetcher
      .on('/api/me', () => Response.json({ username: 'you', via: 'cookie' }))
      .on('/api/sessions', () => Response.json([]))
      .on('/api/attention', () => Response.json([]))
      .on('/api/sessions/01VIEWTEST00000/snapshot', () =>
        Response.json(snapshotFor('01VIEWTEST00000')),
      )
    vi.stubGlobal('fetch', fetcher.handler)
  })

  afterEach(() => {
    sockets.length = 0
    vi.unstubAllGlobals()
  })

  function renderView() {
    return render(
      <MemoryRouter initialEntries={['/s/01VIEWTEST00000']}>
        <AuthProvider>
          <SwarmProvider>
            <Routes>
              <Route path="/s/:sessionId" element={<SessionView />} />
            </Routes>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
  }

  async function openSocket(): Promise<MockWebSocket> {
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0))
    const ws = sockets.at(-1)!
    act(() => ws.open())
    return ws
  }

  it('renders committed history and live turn blocks from the stream', async () => {
    renderView()
    const ws = await openSocket()

    // The subscribe frame rode the shared socket after auth settled.
    expect(JSON.parse(ws.sent[0])).toEqual({ type: 'subscribe', sessionId: '01VIEWTEST00000' })

    const root = messageEntry('01V1', undefined, 'user', 'explain this diff')
    const reply = messageEntry('01V2', '01V1', 'assistant', 'Here is my explanation.')
    frame(ws, {
      type: 'init',
      sessionId: '01VIEWTEST00000',
      state: snapshotFor('01VIEWTEST00000', { head: '01V2' }),
      entries: [root, reply],
    })

    expect(await screen.findByText('explain this diff')).toBeInTheDocument()
    expect(screen.getByText(/Here is my explanation/)).toBeInTheDocument()
    expect(screen.getAllByText('sonnet').length).toBeGreaterThan(0)
    // Seat facts arrive from the snapshot.
    expect(screen.getByText(/seat: swarm/)).toBeInTheDocument()

    // A live turn streams beneath the committed chain with tolerant ordering:
    // progress names the call before its start event arrives.
    frame(ws, {
      type: 'event',
      sessionId: '01VIEWTEST00000',
      event: { event: 'turn.start', seq: 1, data: { model: 'sonnet' } },
    })
    frame(ws, {
      type: 'event',
      sessionId: '01VIEWTEST00000',
      event: { event: 'tool.progress', seq: 2, data: { id: 'c9', name: 'read_file', path: '/x' } },
    })
    frame(ws, {
      type: 'event',
      sessionId: '01VIEWTEST00000',
      event: { event: 'text.delta', seq: 3, data: { delta: 'Working on it…' } },
    })

    expect(screen.getByText('read_file')).toBeInTheDocument()
    await waitFor(() => {
      const blocks = [...screen.getByLabelText('Transcript').querySelectorAll('.live-block pre')]
      return expect(blocks.some((el) => el.textContent?.includes('Working on it…'))).toBe(true)
    })
  })

  it('shows dialogs from the snapshot and answers them over REST', async () => {
    fetcher.on('/api/sessions/01VIEWTEST00000/resolve', () => Response.json({ settled: false }))
    renderView()
    const ws = await openSocket()

    frame(ws, {
      type: 'init',
      sessionId: '01VIEWTEST00000',
      state: snapshotFor('01VIEWTEST00000', {
        interactions: [
          {
            id: 42,
            kind: 'pick',
            prompt: 'Allow write access?',
            options: ['allow', 'deny'],
          },
        ],
      }),
      entries: [],
    })

    expect(await screen.findByText('Allow write access?')).toBeInTheDocument()
    act(() => {
      screen.getByRole('button', { name: 'allow' }).click()
    })

    await waitFor(() => {
      const resolveCalls = fetcher.handler.mock.calls.filter(([url]) =>
        String(url).endsWith('/resolve'),
      )
      expect(resolveCalls).toHaveLength(1)
    })
    const [calledURL, init] = fetcher.handler.mock.calls.find(([url]) =>
      String(url).endsWith('/resolve'),
    )!
    expect(String(calledURL)).toContain('/api/sessions/01VIEWTEST00000/resolve')
    expect(init?.method).toBe('POST')
  })

  it('shows ended and lost phases distinctly', async () => {
    renderView()
    const ws = await openSocket()

    frame(ws, {
      type: 'init',
      sessionId: '01VIEWTEST00000',
      state: snapshotFor('01VIEWTEST00000'),
      entries: [],
    })
    expect(await screen.findByText(/seat: swarm/)).toBeInTheDocument()

    // A clean end announces itself with the backend's child fact.
    frame(ws, { type: 'child', sessionId: '01VIEWTEST00000', state: 'exited' })
    expect(await screen.findByText('Session ended.')).toBeInTheDocument()
  })

  it('shows the connecting banner while no init has arrived', async () => {
    renderView()
    await openSocket() // opened but silent
    expect(await screen.findByText(/Connecting to the session stream/)).toBeInTheDocument()
  })
})

import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SessionView from './SessionView'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'
import { MockWebSocket } from '../test/mockWebSocket'
import { resetDrafts } from '../session/draftStore'

// The backend round trip runs against fetch mocks shaped exactly like the Go
// handlers answer; the stream rides a mock WebSocket through the real client.
// This exercises provider, channel hook, applier and the composed view end to
// end, including the echo-fidelity and pending-row contracts of phase 08.

const VIEW = '01VIEWTEST00000'
const SWAP_A = '01SWAPAAAA000001'
const SWAP_B = '01SWAPBBBB000002'

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

  callsTo(suffix: string): { url: string; init?: RequestInit }[] {
    return this.handler.mock.calls
      .filter(([url]) => String(url).endsWith(suffix))
      .map(([url, init]) => ({ url: String(url), init }))
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

function assistantEntry(id: string, parent: string | undefined, text: string) {
  const e: Record<string, unknown> = { id, type: 'message', ts: 2 }
  if (parent !== undefined) e.parentId = parent
  e.data = JSON.parse(
    `{"message":{"role":"assistant","content":[{"type":"text","data":{"text":${JSON.stringify(text)}}}]}}`,
  )
  return e
}

function frame(ws: MockWebSocket, payload: unknown) {
  act(() => ws.message(payload))
}

function wireEvent(name: string, seq: number, data?: unknown) {
  return { type: 'event', sessionId: VIEW, event: { event: name, seq, data } }
}

describe('SessionView', () => {
  let fetcher: FetchRouter
  const sockets: MockWebSocket[] = []

  beforeEach(() => {
    localStorage.clear()
    resetDrafts() // drafts persist by session, so tests start from a clean slate
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
      .on(`/api/sessions/${VIEW}/snapshot`, () => Response.json(snapshotFor(VIEW)))
    vi.stubGlobal('fetch', fetcher.handler)
  })

  afterEach(() => {
    sockets.length = 0
    vi.unstubAllGlobals()
  })

  function renderView() {
    return render(
      <MemoryRouter initialEntries={[`/s/${VIEW}`]}>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <Routes>
                <Route path="/s/:sessionId" element={<SessionView />} />
              </Routes>
            </WorkspaceProvider>
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

  it('renders committed history, model chip and seat facts from the stream', async () => {
    renderView()
    const ws = await openSocket()

    expect(JSON.parse(ws.sent[0])).toEqual({ type: 'subscribe', sessionId: VIEW })

    frame(ws, {
      type: 'init',
      sessionId: VIEW,
      state: snapshotFor(VIEW, { head: '01V2' }),
      entries: [
        messageEntry('01V1', undefined, 'user', 'explain this diff'),
        assistantEntry('01V2', '01V1', 'Here is **my** explanation.'),
      ],
    })

    expect(await screen.findByText('explain this diff')).toBeInTheDocument()
    // markdown renders through the shared pipeline, not a plain pre
    expect(screen.getByText('my').closest('strong')).not.toBeNull()
    expect(screen.getAllByText('sonnet').length).toBeGreaterThan(0)
    // one clickable affordance covers both idle seat states
    expect(screen.getByRole('button', { name: /take control: swarm/ })).toBeInTheDocument()
  })

  it('streams live turns into one pinned row with tool cards', async () => {
    renderView()
    const ws = await openSocket()

    frame(ws, { type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    frame(ws, wireEvent('turn.start', 1, { model: 'sonnet' }))
    // tolerant ordering: progress may name a call before its start arrives
    frame(ws, wireEvent('tool.progress', 2, { id: 'c9', name: 'read_file', path: '/x' }))
    frame(ws, wireEvent('text.delta', 3, { delta: 'Working on it…' }))

    expect(await screen.findByText('read_file')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/Working on it/)).toBeInTheDocument())
  })

  it('hands streamed content off to its committed entry without duplication', async () => {
    renderView()
    const ws = await openSocket()

    frame(ws, { type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    frame(ws, wireEvent('turn.start', 1, { model: 'sonnet' }))
    frame(ws, wireEvent('text.delta', 2, { delta: 'Hello streamed world' }))

    // the committed copy lands mid-turn, exactly what the stream painted
    const committed = assistantEntry('01A', undefined, 'Hello streamed world')
    frame(ws, wireEvent('entry.append', 3, { entry: committed }))
    await waitFor(async () => {
      const matches = await screen.findAllByText(/Hello streamed world/)
      return expect(matches).toHaveLength(1)
    })

    // turn.end clears the pinned row; still one copy
    frame(ws, wireEvent('turn.end', 4, { stop: 'end_turn' }))
    await waitFor(() => expect(screen.queryByLabelText('Live stream')).not.toBeInTheDocument())
    expect(await screen.findAllByText(/Hello streamed world/)).toHaveLength(1)
  })

  it('retires a live tool card only when its carrier commits', async () => {
    renderView()
    const ws = await openSocket()

    frame(ws, { type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    frame(ws, wireEvent('turn.start', 1, { model: 'sonnet' }))
    frame(ws, wireEvent('tool.start', 2, { id: 'c1', name: 'edit_file', input: '{}' }))
    frame(ws, wireEvent('tool.output', 3, { id: 'c1', delta: 'patching…' }))

    // the assistant message commits while its tool still runs
    const callEntry = {
      id: '01T',
      type: 'message',
      ts: 4,
      data: JSON.parse(
        '{"message":{"role":"assistant","content":[{"type":"tool_call","data":{"id":"c1","name":"edit_file"}}]}}',
      ),
    }
    frame(ws, wireEvent('entry.append', 5, { entry: callEntry }))
    await waitFor(async () => {
      const cards = await screen.findAllByText(/patching/)
      return expect(cards).toHaveLength(1) // the live card covers it
    })

    const carrier = {
      id: '01C',
      parentId: '01T',
      type: 'message',
      ts: 6,
      data: JSON.parse(
        JSON.stringify({
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                data: {
                  callId: 'c1',
                  content: [{ type: 'text', data: { text: 'patched cleanly' } }],
                },
              },
            ],
          },
        }),
      ),
    }
    frame(ws, wireEvent('entry.append', 7, { entry: carrier }))
    // the committed card takes over with its own body, exactly once
    await waitFor(async () => {
      expect(screen.queryByLabelText('Live stream')).not.toBeInTheDocument()
      const cards = await screen.findAllByText(/patched cleanly/)
      return expect(cards).toHaveLength(1)
    })
  })

  it('keeps a manual thinking collapse while the turn streams', async () => {
    renderView()
    const ws = await openSocket()

    frame(ws, { type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    frame(ws, wireEvent('turn.start', 1, { model: 'sonnet' }))
    frame(ws, wireEvent('thinking.delta', 2, { delta: 'working through it' }))

    // the deterministic default mounts expanded while streaming
    const panel = await screen.findByText('thinking…')
    expect(panel.closest('details')?.open).toBe(true)

    const user = userEvent.setup()
    await user.click(panel)

    // further deltas re-render the row without popping the panel back open,
    // and the applier records ownership so thinking.end respects it too
    frame(ws, wireEvent('thinking.delta', 3, { delta: ' and more' }))
    await waitFor(() => expect(screen.getByText(/working through it and more/)))
    const collapsed = screen.getByText('thinking…').closest('details')!
    expect(collapsed.open).toBe(false)

    frame(ws, wireEvent('thinking.end', 4))
    expect(screen.getByText('thinking…').closest('details')!.open).toBe(false)
  })

  it('renders diff events as client-side patch cards', async () => {
    renderView()
    const ws = await openSocket()

    frame(ws, { type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    frame(
      ws,
      wireEvent('diff', 1, { path: 'src/main.go', before: 'one\ntwo\n', after: 'one\nTHREE\n' }),
    )

    const card = await screen.findByTestId('diff-card')
    expect(card.textContent).toContain('src/main.go')
    // unified patch text never rides the wire; lines render with their sign
    expect(card.querySelector('.diff-line.add')?.textContent).toBe('THREE')
    expect(card.querySelector('.diff-line.del')?.textContent).toBe('two')
  })

  it('anchors a diff above committed messages that arrive later', async () => {
    renderView()
    const ws = await openSocket()

    frame(ws, {
      type: 'init',
      sessionId: VIEW,
      state: snapshotFor(VIEW, { head: '01D0' }),
      entries: [messageEntry('01D0', undefined, 'user', 'edit the file')],
    })
    await screen.findByText('edit the file')

    // the edit lands mid-turn, anchored to the chain tail at arrival
    frame(ws, wireEvent('diff', 1, { path: 'src/main.go', before: 'one\n', after: 'two\n' }))
    frame(
      ws,
      wireEvent('entry.append', 2, {
        entry: assistantEntry('01D1', '01D0', 'all done editing'),
      }),
    )

    // the later message stacks below the diff card in document order
    const card = await screen.findByTestId('diff-card')
    const later = await screen.findByText('all done editing')
    expect(card.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders print events as transient cards in the flow', async () => {
    renderView()
    const ws = await openSocket()

    frame(ws, { type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    frame(ws, wireEvent('print', 1, { markdown: '/usage summary here' }))

    expect(await screen.findByText('/usage summary here')).toBeInTheDocument()
  })

  it('shows dialogs above the composer and disables sending while they hold input', async () => {
    fetcher.on(`/api/sessions/${VIEW}/resolve`, () => Response.json({ settled: false }))
    renderView()
    const ws = await openSocket()

    frame(ws, {
      type: 'init',
      sessionId: VIEW,
      state: snapshotFor(VIEW, {
        interactions: [
          { id: 42, kind: 'pick', prompt: 'Allow write access?', options: ['allow', 'deny'] },
        ],
      }),
      entries: [],
    })

    expect(await screen.findByText('Allow write access?')).toBeInTheDocument()
    const send = await screen.findByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()

    act(() => {
      screen.getByRole('button', { name: 'allow' }).click()
    })
    await waitFor(() => {
      const resolveCalls = fetcher.callsTo('/resolve')
      expect(resolveCalls).toHaveLength(1)
    })
  })

  it('takes the dialog caret on the standalone focused view', async () => {
    renderView()
    const ws = await openSocket()

    frame(ws, {
      type: 'init',
      sessionId: VIEW,
      state: snapshotFor(VIEW, {
        interactions: [{ id: 5, kind: 'input', prompt: 'API key?', text: true }],
      }),
      entries: [],
    })

    // the standalone route is always its surface's focused view (the default),
    // so the head dialog's answer mounts with focus
    expect(await screen.findByText('API key?')).toBeInTheDocument()
    const input = document.querySelector('.dialog-card input')
    expect(input).not.toBeNull()
    expect(document.activeElement).toBe(input)
  })

  it('shows the real outcome for dialogs answered elsewhere', async () => {
    renderView()
    const ws = await openSocket()

    frame(ws, { type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    frame(
      ws,
      wireEvent('interaction.pending', 1, {
        id: 9,
        kind: 'pick',
        prompt: 'Pick one',
        options: ['a'],
      }),
    )
    await screen.findByText('Pick one')
    frame(
      ws,
      wireEvent('interaction.settled', 2, { id: 9, kind: 'pick', answered: true, index: 0 }),
    )

    // a resolved state from the settled payload, never an error
    expect(await screen.findByText('Dialog answered')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Pick one')).not.toBeInTheDocument())
  })

  it('paints optimistic rows and resolves them by queueIds, joined entries included', async () => {
    fetcher.on(`/api/sessions/${VIEW}/submit`, () =>
      Response.json({ pendingId: 'p-client' }, { status: 202 }),
    )
    renderView()
    const ws = await openSocket()

    frame(ws, { type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    const promptBox = await screen.findByLabelText('Prompt')

    const user = userEvent.setup()
    await user.type(promptBox, 'first prompt{Enter}')
    // the optimistic row paints before any reply
    expect(screen.getByText(/first prompt/)).toBeInTheDocument()

    // a second optimistic row joins it in the queue
    await user.type(promptBox, 'second prompt{Enter}')
    frame(ws, wireEvent('queued', 1, { rows: [{ id: 'p-client', text: 'first prompt' }] }))

    // one committed entry lands naming both rows: several queued prompts may join
    const joined = {
      id: '01M',
      type: 'message',
      ts: 2,
      data: JSON.parse(
        '{"message":{"role":"user","content":[{"type":"text","data":{"text":"first prompt"}}]},"queueIds":["p-client","p-second"]}',
      ),
    }
    frame(ws, wireEvent('entry.append', 3, { entry: joined }))

    await waitFor(() => {
      const submitCalls = fetcher.callsTo('/submit')
      expect(submitCalls).toHaveLength(2)
      // each submit carries its own client-minted correlation
      const bodies = submitCalls.map((c) => JSON.parse(String(c.init?.body)))
      expect(bodies[0]!.line).toBe('first prompt')
      expect(bodies[1]!.line).toBe('second prompt')
      expect(new Set(bodies.map((b) => b.pendingId)).size).toBe(2)
    })
  })

  it('interrupts a running stream on escape', async () => {
    fetcher.on(`/api/sessions/${VIEW}/interrupt`, () => Response.json({ stopped: VIEW }))
    renderView()
    const ws = await openSocket()

    frame(ws, { type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    frame(ws, wireEvent('turn.start', 1, { model: 'sonnet' }))

    const user = userEvent.setup()
    await user.keyboard('{Escape}')

    await waitFor(() => expect(fetcher.callsTo('/interrupt')).toHaveLength(1))
  })

  it('marks refused submits without losing the draft', async () => {
    fetcher.on(`/api/sessions/${VIEW}/submit`, () =>
      Response.json({ error: 'unavailable', message: 'a dialog holds input' }, { status: 409 }),
    )
    renderView()
    const ws = await openSocket()

    frame(ws, { type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    const promptBox = await screen.findByLabelText('Prompt')

    const user = userEvent.setup()
    await user.type(promptBox, 'my unsent idea{Enter}')

    // the optimistic row resolves as refused; the error surfaces beside it
    expect(await screen.findByText(/a dialog holds input/)).toBeInTheDocument()
    expect(screen.getByText('refused')).toBeInTheDocument()
    // and the composer still holds exactly what was typed
    expect(promptBox).toHaveValue('my unsent idea')
  })

  it('prefills a rewound prompt above an existing draft with a notice', async () => {
    fetcher.on(`/api/sessions/${VIEW}/candidates`, () =>
      Response.json({
        head: '01C1',
        candidates: [{ id: '01C0', kind: 'user', ts: 1000, isHead: false, text: 'rewound prompt' }],
      }),
    )
    fetcher.on(`/api/sessions/${VIEW}/rewind`, () => Response.json({ head: '01C0' }))
    renderView()
    const ws = await openSocket()

    frame(ws, { type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    const promptBox = await screen.findByLabelText('Prompt')
    const user = userEvent.setup()
    await user.type(promptBox, 'my draft')

    await user.click(screen.getByRole('button', { name: 'Rewind' }))
    await user.click(await screen.findByRole('button', { name: /^prompt/ }))

    // the rewind lands above what was typed instead of overwriting it
    expect(promptBox).toHaveValue('rewound prompt\nmy draft')
    expect(await screen.findByText('Placed above your existing draft.')).toBeInTheDocument()
  })

  it('restores a recalled queue row through the same prefill rule', async () => {
    fetcher.on(`/api/sessions/${VIEW}/recall`, () =>
      Response.json({ id: 'q1', text: 'recalled prompt' }),
    )
    renderView()
    const ws = await openSocket()

    frame(ws, { type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    frame(
      ws,
      wireEvent('queued', 1, {
        rows: [
          { id: 'q0', text: 'older row' },
          { id: 'q1', text: 'recalled prompt' },
        ],
      }),
    )

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /edit/ }))

    // the newest row pops into an empty composer whole
    expect(await screen.findByLabelText('Prompt')).toHaveValue('recalled prompt')
  })

  it('badges queue drops with their cause and redacts secret rows', async () => {
    renderView()
    const ws = await openSocket()

    frame(ws, { type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    frame(
      ws,
      wireEvent('queued', 1, {
        rows: [
          { id: 'c1', text: 'explain this diff' },
          { id: 's2', text: '' },
        ],
      }),
    )
    frame(ws, wireEvent('queue.dropped', 2, { rows: [{ id: 's2', text: '' }], cause: 'interrupt' }))

    expect(await screen.findByText(/secret prompt s2/)).toBeInTheDocument()
    expect(screen.getByText('explain this diff')).toBeInTheDocument()
    // the drop keeps its row visible with the reason named
    const chips = screen.getAllByText(/secret prompt s2/)
    expect(chips.length).toBeGreaterThan(0)
  })

  it('virtualizes a long transcript and still reaches the latest entry', async () => {
    renderView()
    const ws = await openSocket()

    // generate a chain far longer than one window
    const entries: Record<string, unknown>[] = []
    let parent: string | undefined = undefined
    for (let i = 0; i < 400; i++) {
      const id = `01LONG${String(i).padStart(5, '0')}`
      entries.push(messageEntry(id, parent, i % 2 === 0 ? 'user' : 'assistant', `entry body ${i}`))
      parent = id
    }
    frame(ws, {
      type: 'init',
      sessionId: VIEW,
      state: snapshotFor(VIEW, { head: parent }),
      entries,
    })

    await screen.findByText('entry body 0')
    // far fewer rows render than the chain holds
    const rendered = document.querySelectorAll('[data-entry-id]').length
    expect(rendered).toBeLessThan(100)
    expect(screen.getByText('entry body 0')).toBeInTheDocument()
    expect(screen.queryByText('entry body 399')).not.toBeInTheDocument()

    // scroll to the bottom: the latest entry renders there
    const scroller = document.querySelector('.transcript-scroll') as HTMLElement
    act(() => {
      scroller.scrollTop = 400 * 72
      scroller.dispatchEvent(new Event('scroll'))
    })
    expect(await screen.findByText('entry body 399')).toBeInTheDocument()
  })

  it('shows ended and lost phases distinctly', async () => {
    renderView()
    const ws = await openSocket()

    frame(ws, { type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    expect(await screen.findByRole('button', { name: /take control: swarm/ })).toBeInTheDocument()

    // A clean end announces itself with the backend's child fact.
    frame(ws, { type: 'child', sessionId: VIEW, state: 'exited' })
    expect(await screen.findByText('Session ended.')).toBeInTheDocument()
  })

  it('hides the seat takeover when the seat is free or already ours', async () => {
    renderView()
    const ws = await openSocket()

    // a free seat costs nothing to use, so there is nothing to claim
    frame(ws, {
      type: 'init',
      sessionId: VIEW,
      state: snapshotFor(VIEW, { seat: { held: false, yours: false } }),
      entries: [],
    })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /claim control/ })).not.toBeInTheDocument(),
    )
    expect(screen.queryByRole('button', { name: /take control/ })).not.toBeInTheDocument()

    // a seat this viewer already holds is equally uncontested
    frame(ws, {
      type: 'init',
      sessionId: VIEW,
      state: snapshotFor(VIEW, { seat: { held: true, holder: 'swarm', yours: true } }),
      entries: [],
    })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /take control/ })).not.toBeInTheDocument(),
    )
  })

  // Hosted views swap sessions by prop (focus rail, tile tabs); the key on the
  // content must present every swap as a remount so chrome and drafts follow
  // the session instead of bleeding across it.
  function renderHosted(id: string) {
    return render(
      <MemoryRouter>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <SessionView sessionId={id} />
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
  }

  it('remounts per session so chrome and drafts never bleed across a swap', async () => {
    fetcher.on(`/api/sessions/${SWAP_A}/snapshot`, () => Response.json(snapshotFor(SWAP_A)))
    fetcher.on(`/api/sessions/${SWAP_B}/snapshot`, () => Response.json(snapshotFor(SWAP_B)))
    fetcher.on(`/api/sessions/${SWAP_A}/candidates`, () =>
      Response.json({ head: '', candidates: [] }),
    )
    const view = renderHosted(SWAP_A)
    const ws = await openSocket()

    frame(ws, { type: 'init', sessionId: SWAP_A, state: snapshotFor(SWAP_A), entries: [] })
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('Prompt'), 'alpha draft')

    // transient chrome opens over the first session
    await user.click(screen.getByRole('button', { name: 'Rewind' }))
    expect(
      await screen.findByRole('dialog', { name: 'Rewind to an earlier point' }),
    ).toBeInTheDocument()

    // swapping presents the other session fresh: dialog closed, empty composer
    view.rerender(
      <MemoryRouter>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <SessionView sessionId={SWAP_B} />
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    frame(ws, { type: 'init', sessionId: SWAP_B, state: snapshotFor(SWAP_B), entries: [] })
    expect(
      screen.queryByRole('dialog', { name: 'Rewind to an earlier point' }),
    ).not.toBeInTheDocument()
    expect(await screen.findByLabelText('Prompt')).toHaveValue('')

    // switching back restores that session's own draft from the store
    view.rerender(
      <MemoryRouter>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <SessionView sessionId={SWAP_A} />
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByLabelText('Prompt')).toHaveValue('alpha draft')
  })

  it('shows the connecting banner while no init has arrived', async () => {
    renderView()
    await openSocket() // opened but silent
    expect(await screen.findByText(/Connecting to the session stream/)).toBeInTheDocument()
  })
})

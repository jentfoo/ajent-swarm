import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import MobileSessionScreen from './MobileSessionScreen'
import type { ReactElement } from 'react'
import { useNavigate } from 'react-router'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'
import { resetDrafts } from '../session/draftStore'
import { MockWebSocket } from '../test/mockWebSocket'
import { resetLedger } from '../workspace/attention'

// The mobile single-session screen over the real stream client: compact
// chrome, keyboard-aware padding against a mocked visualViewport, tools as a
// pushed sheet, and rewind as a flat recent-prompt list.

const VIEW = '01MOBILEVIEW00000'
const OTHER = '01MOBILEVIEW00001'

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
    tools: [{ name: 'read_file', source: 'built-in', enabled: true, readOnly: false }],
    usage: {
      turns: 0,
      total: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      child: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    },
    context: { used: 1000, window: 200_000, reserve: 20_000, compact: 150_000, estimated: false },
    running: false,
    idle: true,
    spinning: false,
    queued: 2,
    queuedRows: [],
    activity: [{ key: 'sub-1', text: 'scanning files', rank: 0 }],
    status: { segments: [{ key: 'ctx', text: 'context 40k', short: 'ctx 40k', order: 1 }] },
    seat: { held: true, holder: 'swarm', yours: false },
    ...overrides,
  }
}

describe('MobileSessionScreen', () => {
  let fetcher: FetchRouter
  const sockets: MockWebSocket[] = []
  let vvHeight: number

  beforeEach(() => {
    localStorage.clear()
    resetDrafts() // drafts persist by session, so tests start from a clean slate
    resetLedger()
    vvHeight = window.innerHeight // keyboard closed by default

    // visualViewport stand-in with a mutable height for the inset hook
    const listeners: Array<() => void> = []
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        get height() {
          return vvHeight
        },
        offsetTop: 0,
        addEventListener: (_: string, cb: () => void) => listeners.push(cb),
        removeEventListener: (_: string, cb: () => void) => {
          const i = listeners.indexOf(cb)
          if (i >= 0) listeners.splice(i, 1)
        },
        fire: () => listeners.forEach((cb) => cb()),
      },
    })

    fetcher = new FetchRouter()
    fetcher
      .on('/api/me', () => Response.json({ username: 'you', via: 'cookie', home: '/home/you' }))
      .on('/api/sessions', () =>
        Response.json([
          {
            sessionId: VIEW,
            state: 'online',
            seatHeld: false,
            seatOurs: false,
            running: false,
            idle: true,
            openInteractions: 0,
            spawnedBy: 'external',
          },
        ]),
      )
      .on('/api/attention', () => Response.json([]))
      .on(`/api/sessions/${VIEW}/snapshot`, () => Response.json(snapshotFor(VIEW)))
    vi.stubGlobal(
      'WebSocket',
      class extends MockWebSocket {
        constructor(url: string) {
          super(url)
          sockets.push(this)
        }
      },
    )
    vi.stubGlobal('fetch', fetcher.handler)
  })

  afterEach(() => {
    sockets.length = 0
    Reflect.deleteProperty(window, 'visualViewport')
    vi.unstubAllGlobals()
  })

  function renderScreen() {
    return render(
      <MemoryRouter initialEntries={[`/s/${VIEW}`]}>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <Routes>
                <Route path="/s/:sessionId" element={<MobileSessionScreen />} />
              </Routes>
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
  }

  async function openSocket(): Promise<MockWebSocket> {
    await waitForSocket()
    const ws = sockets.at(-1)!
    act(() => ws.open())
    return ws
  }

  function waitForSocket() {
    return vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0))
  }

  // NavButton drives MemoryRouter between the two session routes, standing in
  // for the launcher and switcher navigations that reuse one screen instance.
  function NavButton({ to, children }: { to: string; children: string }): ReactElement {
    const navigate = useNavigate()
    return (
      <button type="button" onClick={() => navigate(to)}>
        {children}
      </button>
    )
  }

  function renderSwitchable() {
    return render(
      <MemoryRouter initialEntries={[`/s/${VIEW}`]}>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <NavButton to={`/s/${OTHER}`}>go other</NavButton>
              <NavButton to={`/s/${VIEW}`}>go view</NavButton>
              <Routes>
                <Route path="/s/:sessionId" element={<MobileSessionScreen />} />
              </Routes>
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
  }

  it('renders the compact chrome with the shared status bar', async () => {
    renderScreen()
    const ws = await openSocket()

    act(() => {
      ws.message({
        type: 'init',
        sessionId: VIEW,
        state: snapshotFor(VIEW),
        entries: [],
      })
    })

    // header collapses to model plus spinner affordance; no desktop controls
    expect(await screen.findByRole('button', { name: /sonnet/ })).toBeInTheDocument()
    expect(screen.getByLabelText('Back to launcher')).toBeInTheDocument()

    // the bar reads one data source with desktop's: queue depth, segments and
    // sub-agent chips
    expect(screen.getByText('2 queued')).toBeInTheDocument()
    expect(screen.getByText('ctx 40k')).toBeInTheDocument()
    expect(screen.getByText(/1 agent/)).toBeInTheDocument()
  })

  it('keeps the status bar visible on an idle session', async () => {
    renderScreen()
    const ws = await openSocket()
    act(() => {
      ws.message({
        type: 'init',
        sessionId: VIEW,
        state: snapshotFor(VIEW, {
          queued: 0,
          activity: [],
          status: { segments: [] },
        }),
        entries: [],
      })
    })

    // the resting dim glyph answers "is it working" with nothing else to report
    expect(await screen.findByLabelText('idle')).toBeInTheDocument()
    expect(document.querySelector('.status-bar')).toBeInTheDocument()
    expect(document.querySelector('.status-strip')).not.toBeInTheDocument()
  })

  it('flips the spinner to working and shows the activity line', async () => {
    renderScreen()
    const ws = await openSocket()
    act(() => {
      ws.message({
        type: 'init',
        sessionId: VIEW,
        state: snapshotFor(VIEW, {
          running: true,
          idle: false,
          activity: [
            { key: 'step', text: 'reading files', rank: 10 },
            { key: 'sub-1', text: 'scanning files', rank: 0 },
          ],
        }),
        entries: [],
      })
    })

    expect(await screen.findByText('reading files')).toBeInTheDocument()
    // the glyph never rests dim while the turn runs
    const bar = document.querySelector('.status-bar')!
    expect(bar.querySelector('.spinner.wait')).toBeInTheDocument()
    expect(bar.querySelector('.spinner.idle')).not.toBeInTheDocument()
  })

  it('renders the context meter only when the window is known', async () => {
    renderScreen()
    const ws = await openSocket()
    act(() => {
      ws.message({ type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    })

    // 1k of a 200k window meters one percent, labeled for screen readers
    expect(await screen.findByRole('img', { name: 'Context 1% full' })).toBeInTheDocument()

    // an unknown window size leaves nothing to meter
    act(() => {
      ws.message({
        type: 'init',
        sessionId: VIEW,
        state: snapshotFor(VIEW, {
          context: { used: 0, window: 0, reserve: 0, compact: 0, estimated: false },
        }),
        entries: [],
      })
    })
    expect(screen.queryByRole('img', { name: /Context/ })).not.toBeInTheDocument()
  })

  it('feeds the keyboard inset to css for composer and overlays', async () => {
    renderScreen()
    const ws = await openSocket()
    act(() => {
      ws.message({ type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    })
    await screen.findByRole('button', { name: /sonnet/ })

    // the sheet pads above the keyboard through --keyboard-inset; theme.css
    // adds the safe-area baseline and lifts fixed overlays with the same value
    const screenEl = document.querySelector('.mobile-session') as HTMLElement
    expect(screenEl.style.getPropertyValue('--keyboard-inset')).toBe('0px')

    // the keyboard rises in steps; every intermediate inset lands so the
    // transcript stays visible and autoscroll stays pinned while it animates
    vvHeight = window.innerHeight - 120
    act(() => {
      ;(window.visualViewport as unknown as { fire: () => void }).fire()
    })
    expect(screenEl.style.getPropertyValue('--keyboard-inset')).toBe('120px')

    vvHeight = window.innerHeight - 300
    act(() => {
      ;(window.visualViewport as unknown as { fire: () => void }).fire()
    })
    expect(screenEl.style.getPropertyValue('--keyboard-inset')).toBe('300px')

    // keyboard closed again returns to the safe-area baseline alone
    vvHeight = window.innerHeight
    act(() => {
      ;(window.visualViewport as unknown as { fire: () => void }).fire()
    })
    expect(screenEl.style.getPropertyValue('--keyboard-inset')).toBe('0px')
  })

  it('pushes the tools panel full-screen from the header', async () => {
    renderScreen()
    const ws = await openSocket()
    act(() => {
      ws.message({ type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    })
    await screen.findByRole('button', { name: /sonnet/ })

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Open tools panel' }))
    expect(await screen.findByRole('dialog', { name: 'Tools' })).toBeInTheDocument()
    expect(screen.getByText('read_file')).toBeInTheDocument()

    // toggling applies the complete desired set through tools.set
    fetcher.on(`/api/sessions/${VIEW}/tools`, () =>
      Response.json({
        rows: [{ name: 'read_file', source: 'built-in', enabled: false, readOnly: false }],
      }),
    )
    await user.click(screen.getByRole('checkbox'))
    await vi.waitFor(() => {
      const calls = fetcher.handler.mock.calls.filter(([u]) => String(u).endsWith('/tools'))
      expect(calls.length).toBeGreaterThan(0)
    })
  })

  it('presents rewind as a flat list of recent prompts that prefills', async () => {
    renderScreen()
    const ws = await openSocket()
    act(() => {
      ws.message({ type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    })
    await screen.findByRole('button', { name: /sonnet/ })

    fetcher.on(`/api/sessions/${VIEW}/candidates`, () =>
      Response.json({
        head: '01C3',
        candidates: [
          {
            id: '01C1',
            kind: 'user',
            ts: 1000,
            isHead: false,
            text: 'first prompt text',
          },
          {
            id: '01C2',
            kind: 'assistant',
            ts: 2000,
            isHead: false,
            label: 'reply',
          },
          {
            id: '01C3',
            kind: 'user',
            ts: 3000,
            isHead: true,
            text: 'current prompt',
          },
        ],
      }),
    )
    fetcher.on(`/api/sessions/${VIEW}/rewind`, () => Response.json({ head: '01C1' }))

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Rewind' }))
    expect(await screen.findByRole('dialog', { name: /Rewind/ })).toBeInTheDocument()

    // assistant replies stay out; only recent prompts list, head disabled
    expect(screen.getByText('first prompt text')).toBeInTheDocument()
    expect(screen.queryByText('reply')).not.toBeInTheDocument()
    expect(screen.getByTestId('rewind-01C3')).toBeDisabled()

    // a draft in the composer survives: the rewind lands above it
    await user.type(screen.getByLabelText('Prompt'), 'my draft')

    await user.click(screen.getByTestId('rewind-01C1'))
    await vi.waitFor(() => {
      const rewindCalls = fetcher.handler.mock.calls.filter(([u]) => String(u).endsWith('/rewind'))
      expect(rewindCalls).toHaveLength(1)
    })

    // the full prompt text lands above the draft for an edit, noticed by toast
    await vi.waitFor(() =>
      expect(screen.getByLabelText('Prompt')).toHaveValue('first prompt text\nmy draft'),
    )
    expect(await screen.findByText('Placed above your existing draft.')).toBeInTheDocument()
  })

  it('opens the switcher from a dominant horizontal edge swipe', async () => {
    renderScreen()
    const ws = await openSocket()
    act(() => {
      ws.message({ type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    })
    await screen.findByRole('button', { name: /sonnet/ })

    const surface = document.querySelector('.mobile-session') as HTMLElement
    fireEvent.touchStart(surface, {
      touches: [{ clientX: 10, clientY: 300 }],
      changedTouches: [{ clientX: 10, clientY: 300 }],
    })
    fireEvent.touchEnd(surface, { touches: [], changedTouches: [{ clientX: 80, clientY: 306 }] })

    expect(await screen.findByRole('dialog', { name: 'Session switcher' })).toBeInTheDocument()
  })

  it('keeps a vertical edge scroll from opening the switcher', async () => {
    renderScreen()
    const ws = await openSocket()
    act(() => {
      ws.message({ type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    })
    await screen.findByRole('button', { name: /sonnet/ })

    // a scroll that starts at the edge and ends 60px right of it is a scroll
    const surface = document.querySelector('.mobile-session') as HTMLElement
    fireEvent.touchStart(surface, {
      touches: [{ clientX: 10, clientY: 100 }],
      changedTouches: [{ clientX: 10, clientY: 100 }],
    })
    fireEvent.touchEnd(surface, { touches: [], changedTouches: [{ clientX: 70, clientY: 400 }] })

    expect(screen.queryByRole('dialog', { name: 'Session switcher' })).not.toBeInTheDocument()
  })

  it('keeps a second finger from opening the switcher', async () => {
    renderScreen()
    const ws = await openSocket()
    act(() => {
      ws.message({ type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    })
    await screen.findByRole('button', { name: /sonnet/ })

    // one finger seeds the gesture at the edge; a pinch kills it even when
    // the last finger lifts far right of where the first landed
    const surface = document.querySelector('.mobile-session') as HTMLElement
    fireEvent.touchStart(surface, {
      touches: [{ clientX: 10, clientY: 300 }],
      changedTouches: [{ clientX: 10, clientY: 300 }],
    })
    fireEvent.touchStart(surface, {
      touches: [
        { clientX: 10, clientY: 300 },
        { clientX: 250, clientY: 320 },
      ],
      changedTouches: [{ clientX: 250, clientY: 320 }],
    })
    fireEvent.touchEnd(surface, {
      touches: [{ clientX: 10, clientY: 300 }],
      changedTouches: [{ clientX: 250, clientY: 320 }],
    })
    fireEvent.touchEnd(surface, { touches: [], changedTouches: [{ clientX: 120, clientY: 310 }] })

    expect(screen.queryByRole('dialog', { name: 'Session switcher' })).not.toBeInTheDocument()
  })

  it('shows the seat claim only while someone else holds the write seat', async () => {
    renderScreen()
    const ws = await openSocket()
    act(() => {
      ws.message({ type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    })
    expect(await screen.findByText('seat: swarm')).toBeInTheDocument()

    // a free seat renders nothing; writes take the seat lazily
    act(() => {
      ws.message({
        type: 'init',
        sessionId: VIEW,
        state: snapshotFor(VIEW, { seat: { held: false, yours: false } }),
        entries: [],
      })
    })
    expect(screen.queryByText('seat: swarm')).not.toBeInTheDocument()
    expect(screen.queryByText('seat held')).not.toBeInTheDocument()

    // one this connection holds is not contested either
    act(() => {
      ws.message({
        type: 'init',
        sessionId: VIEW,
        state: snapshotFor(VIEW, { seat: { held: true, holder: 'swarm', yours: true } }),
        entries: [],
      })
    })
    expect(screen.queryByText('seat: swarm')).not.toBeInTheDocument()
  })

  it('presents a switched session fresh and restores its own draft on return', async () => {
    fetcher.on('/api/sessions', () =>
      Response.json([
        {
          sessionId: VIEW,
          state: 'online',
          seatHeld: false,
          seatOurs: false,
          running: false,
          idle: true,
          openInteractions: 0,
          spawnedBy: 'external',
        },
        {
          sessionId: OTHER,
          state: 'online',
          seatHeld: false,
          seatOurs: false,
          running: false,
          idle: true,
          openInteractions: 0,
          spawnedBy: 'external',
        },
      ]),
    )
    fetcher.on(`/api/sessions/${OTHER}/snapshot`, () => Response.json(snapshotFor(OTHER)))
    fetcher.on(`/api/sessions/${VIEW}/models`, () =>
      Response.json({
        active: 'anthropic/claude-sonnet',
        models: [
          {
            key: 'anthropic/claude-sonnet',
            short: 'sonnet',
            window: 200_000,
            caps: { reasoning: true, images: false, parallelToolCalls: true },
          },
        ],
      }),
    )
    renderSwitchable()
    const ws = await openSocket()

    act(() => {
      ws.message({ type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    })
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('Prompt'), 'alpha draft')

    // the tools sheet and the model menu stand open over the first session
    await user.click(screen.getByRole('button', { name: 'Open tools panel' }))
    expect(await screen.findByRole('dialog', { name: 'Tools' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /sonnet/ }))
    expect(await screen.findByText('anthropic/claude-sonnet')).toBeInTheDocument()

    // the swap presents the other session fresh: sheet and menu closed, and a
    // draft typed for the first session is not sitting in the composer
    await user.click(screen.getByRole('button', { name: 'go other' }))
    act(() => {
      ws.message({ type: 'init', sessionId: OTHER, state: snapshotFor(OTHER), entries: [] })
    })
    expect(await screen.findByLabelText('Prompt')).toHaveValue('')
    expect(screen.queryByRole('dialog', { name: 'Tools' })).not.toBeInTheDocument()
    expect(screen.queryByText('anthropic/claude-sonnet')).not.toBeInTheDocument()

    // returning restores that session's draft from the store, not a blank
    await user.click(screen.getByRole('button', { name: 'go view' }))
    expect(await screen.findByLabelText('Prompt')).toHaveValue('alpha draft')
  })
})

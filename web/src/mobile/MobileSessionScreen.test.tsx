import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import MobileSessionScreen from './MobileSessionScreen'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'
import { MockWebSocket } from '../test/mockWebSocket'
import { resetLedger } from '../workspace/attention'

// The mobile single-session screen over the real stream client: compact
// chrome, keyboard-aware padding against a mocked visualViewport, tools as a
// pushed sheet, and rewind as a flat recent-prompt list.

const VIEW = '01MOBILEVIEW00000'

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

  it('renders the compact chrome with status strip and queue count', async () => {
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

    // the strip reads one data source with the desktop status bar
    expect(screen.getByText('2 queued')).toBeInTheDocument()
    expect(screen.getByText('ctx 40k'))
    expect(screen.getByLabelText(/1 active/)).toBeInTheDocument()
  })

  it('pads above the keyboard while it animates', async () => {
    renderScreen()
    const ws = await openSocket()
    act(() => {
      ws.message({ type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    })
    await screen.findByRole('button', { name: /sonnet/ })

    const screenEl = document.querySelector('.mobile-session') as HTMLElement
    expect(screenEl.style.paddingBottom).toBe('')

    // the keyboard rises in steps; every intermediate inset lands so the
    // transcript stays visible and autoscroll stays pinned while it animates
    vvHeight = window.innerHeight - 120
    act(() => {
      ;(window.visualViewport as unknown as { fire: () => void }).fire()
    })
    expect(screenEl.style.paddingBottom).toBe('120px')

    vvHeight = window.innerHeight - 300
    act(() => {
      ;(window.visualViewport as unknown as { fire: () => void }).fire()
    })
    expect(screenEl.style.paddingBottom).toBe('300px')

    // keyboard closed again clears the padding
    vvHeight = window.innerHeight
    act(() => {
      ;(window.visualViewport as unknown as { fire: () => void }).fire()
    })
    expect(screenEl.style.paddingBottom).toBe('')
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

    await user.click(screen.getByTestId('rewind-01C1'))
    await vi.waitFor(() => {
      const rewindCalls = fetcher.handler.mock.calls.filter(([u]) => String(u).endsWith('/rewind'))
      expect(rewindCalls).toHaveLength(1)
    })

    // the full prompt text lands in the composer for an edit
    await vi.waitFor(() => expect(screen.getByLabelText('Prompt')).toHaveValue('first prompt text'))
  })
})

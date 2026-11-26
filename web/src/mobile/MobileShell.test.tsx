import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import MobileShell from './MobileShell'
import type { AttentionRow } from '../api/types'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'
import { MockWebSocket } from '../test/mockWebSocket'

// The shell rides the real provider stack over fetch and WebSocket mocks, and
// the route table stays a catch-all: the pathname decides the active tab, not
// the mounted screen. Session screens go immersive, the top bar stands down
// while the connection banner and notification prompt keep rendering.

function LocationProbe(): ReactElement {
  const location = useLocation()
  return <span data-testid="url">{location.pathname}</span>
}

describe('MobileShell', () => {
  let routes: Map<string, () => Response>
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('WebSocket', MockWebSocket)
    routes = new Map<string, () => Response>([
      ['/api/me', () => Response.json({ username: 'you', via: 'cookie' })],
      ['/api/sessions', () => Response.json([])],
      // one open dialog so the badge and prompt have their moment, and its
      // arrival settles the provider reads before assertions run
      [
        '/api/attention',
        () =>
          Response.json([
            {
              sessionId: 's1',
              pid: 7,
              openInteractions: 1,
              dialogId: 3,
              running: false,
              idle: true,
              kind: 'needs-input',
              reason: 'Allow write access?',
            },
          ]),
      ],
    ])
    fetchMock = vi.fn((url: string | URL) => {
      const path = String(url)
        .replace(/^https?:\/\/[^/]+/, '')
        .split('?')[0]
      const respond = routes.get(path)
      if (!respond) throw new Error(`unexpected fetch ${path}`)
      return Promise.resolve(respond())
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(window, 'visualViewport')
    document.body.innerHTML = '' // drops the seeded editable and toast probe
  })

  // renderShell mounts the shell and lets the attention read settle inside
  // act, so badge and prompt assertions start from a settled provider on every
  // route, the immersive ones included where no top-bar badge can signal it
  async function renderShell(initialEntry: string) {
    const view = render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <Routes>
                <Route
                  path="*"
                  element={
                    <MobileShell>
                      <LocationProbe />
                    </MobileShell>
                  }
                />
              </Routes>
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).split('?')[0] === '/api/attention'),
      ).toBe(true),
    )
    await act(async () => {})
    return view
  }

  // row builds one digest row; only the ranked facts matter to these tests.
  function row(overrides: Partial<AttentionRow> & { sessionId: string }): AttentionRow {
    return { openInteractions: 0, running: false, idle: true, kind: 'awaiting', ...overrides }
  }

  it.each([
    ['/', 'Sessions'],
    ['/jobs', 'Jobs'],
    ['/jobs/runs', 'Jobs'],
    ['/jobs/01JOB0000000', 'Jobs'],
    ['/m/settings', null],
    ['/m/read/01ENDED00000000', 'Sessions'],
  ])('marks exactly one tab current on %s', async (path, active) => {
    await renderShell(path)

    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
    for (const name of ['Sessions', 'Jobs']) {
      const el = screen.getByRole('link', { name })
      // the class carries the look, aria-current carries the semantics
      if (name === active) {
        expect(el).toHaveClass('active')
        expect(el).toHaveAttribute('aria-current', 'page')
      } else {
        expect(el).not.toHaveClass('active')
        expect(el).not.toHaveAttribute('aria-current')
      }
    }
  })

  it.each(['/', '/jobs', '/m/settings', '/m/read/01ENDED00000000'])(
    'keeps the top bar on %s',
    async (path) => {
      await renderShell(path)

      expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
      expect(document.querySelector('.mobile-shell')).not.toHaveClass('immersive')
    },
  )

  it('drops the top bar on a session screen', async () => {
    await renderShell('/s/01ABC0000000')

    // the session header owns the chrome there, the shell adds none of its own
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull()
    expect(document.querySelector('.mobile-shell')).toHaveClass('immersive')
    expect(screen.getByTestId('url')).toHaveTextContent('/s/01ABC0000000')
  })

  it('links the settings shortcut from the top bar', async () => {
    await renderShell('/')
    const user = userEvent.setup()

    // an icon link, so its accessible name is all assistive tech reads
    const settings = screen.getByRole('link', { name: 'Settings' })
    expect(settings).toHaveAttribute('href', '/m/settings')
    await user.click(settings)
    expect(await screen.findByTestId('url')).toHaveTextContent('/m/settings')
  })

  it('keeps the connection banner and notification prompt on a session screen', async () => {
    // jsdom ships no Notification, the stand-in leaves permission undecided so
    // the prompt has its moment
    vi.stubGlobal(
      'Notification',
      class {
        static permission = 'default'
      },
    )
    await renderShell('/s/01ABC0000000')

    // the socket never opens under the mock, so the banner holds its
    // connecting line; neither notice depends on the top bar
    expect(screen.getByText('Connecting to live updates…')).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'Enable notifications' })).toBeInTheDocument()
  })

  it('reaches Jobs and back from a deep-linked ended session', async () => {
    await renderShell('/m/read/01ENDED00000000')
    const user = userEvent.setup()

    await user.click(screen.getByRole('link', { name: 'Jobs' }))
    expect(await screen.findByTestId('url')).toHaveTextContent('/jobs')

    await user.click(screen.getByRole('link', { name: 'Sessions' }))
    expect(await screen.findByTestId('url')).toHaveTextContent('/')
  })

  it('opens the ranked first needs-input session', async () => {
    routes.set('/api/attention', () =>
      Response.json([
        row({
          sessionId: 'sr',
          pid: 5,
          lastTurnEnd: 50,
          kind: 'needs-review',
          reason: 'turn complete',
          since: 50,
        }),
        row({
          sessionId: 's-old',
          openInteractions: 1,
          dialogId: 3,
          kind: 'needs-input',
          reason: 'Allow write access?',
          since: 100,
        }),
        row({
          sessionId: 's-new',
          openInteractions: 1,
          dialogId: 4,
          kind: 'needs-input',
          reason: 'Approve tool use?',
          since: 300,
        }),
      ]),
    )
    await renderShell('/jobs')
    const user = userEvent.setup()

    // the older review outranks both dialogs but never wins the badge target
    await user.click(await screen.findByRole('link', { name: '2 sessions need input' }))

    expect(await screen.findByTestId('url')).toHaveTextContent('/s/s-old')
  })

  it('opens one dialog at its encoded session route', async () => {
    routes.set('/api/attention', () =>
      Response.json([
        row({
          sessionId: 'one two',
          openInteractions: 1,
          dialogId: 3,
          kind: 'needs-input',
          reason: 'Allow write access?',
          since: 100,
        }),
      ]),
    )
    await renderShell('/')
    const user = userEvent.setup()

    await user.click(await screen.findByRole('link', { name: '1 sessions need input' }))

    expect(await screen.findByTestId('url')).toHaveTextContent('/s/one%20two')
  })

  // keyboardViewport stands in for visualViewport like useKeyboardInset.test:
  // resize events stand in for keyboard animation frames, and an inset means a
  // keyboard, which only exists while text entry holds focus.
  function keyboardViewport(): EventTarget & { height: number; scale: number } {
    const vv = new EventTarget() as EventTarget & { height: number; scale: number }
    vv.height = 800 // full viewport, no keyboard
    vv.scale = 1
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv })
    return vv
  }

  // openKeyboard seeds one focused editable, then shrinks the visual viewport:
  // a keyboard only exists while text entry holds focus.
  function openKeyboard(vv: EventTarget & { height: number }): HTMLInputElement {
    const input = document.createElement('input')
    document.body.appendChild(input)
    act(() => {
      input.focus()
      vv.height = 500 // the keyboard covers a third of the layout viewport
      vv.dispatchEvent(new Event('resize'))
    })
    return input
  }

  it('publishes one keyboard inset for every mobile screen', async () => {
    const vv = keyboardViewport()
    await renderShell('/')

    // closed keyboard publishes zero, so nothing shifts at rest
    expect(document.documentElement.style.getPropertyValue('--keyboard-inset')).toBe('0px')

    const input = openKeyboard(vv)
    expect(document.documentElement.style.getPropertyValue('--keyboard-inset')).toBe('300px')

    // every fixed overlay inherits the root value, so a toast on home lifts
    // above the keyboard exactly like one over an open session
    const toasts = document.createElement('div')
    toasts.className = 'toasts'
    document.querySelector('.mobile-shell')!.appendChild(toasts)
    expect(getComputedStyle(toasts).getPropertyValue('--keyboard-inset')).toBe('300px')

    // releasing the editable drops the lift back to zero
    act(() => {
      input.blur()
    })
    expect(document.documentElement.style.getPropertyValue('--keyboard-inset')).toBe('0px')
  })

  it('clears the inset on unmount so desktop reads zero', async () => {
    const vv = keyboardViewport()
    const view = await renderShell('/')

    openKeyboard(vv)
    expect(document.documentElement.style.getPropertyValue('--keyboard-inset')).toBe('300px')

    // crossing the breakpoint to AppShell unmounts this shell; a stale inset
    // would lift desktop's own toasts off the bottom edge
    view.unmount()
    expect(document.documentElement.style.getPropertyValue('--keyboard-inset')).toBe('')
  })
})

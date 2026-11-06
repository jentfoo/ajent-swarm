import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useParams } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SwitcherRows } from './SwitcherRows'
import type { SwitcherRow } from './switcher'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'
import { resetLedger } from '../workspace/attention'

// The switcher's interactive contract at its breakpoint: rows group under
// muted desktop-rail headings, rename via long-press or the explicit action
// shares one editor that writes swarm storage and suppresses the tap,
// awaiting rows never offer a check-off, live needs-input rows offer one
// backed by the digest, stop arms before it fires and disarms on a poll
// re-render or sheet scroll, and the trailing actions hit their endpoints and
// rebind a single pushed settings screen without tripping the row's own gestures.

function row(overrides: Partial<SwitcherRow> = {}): SwitcherRow {
  return {
    sessionId: '01A',
    label: 'project',
    status: 'idle',
    section: 'working',
    needsInput: false,
    reason: '',
    queued: 0,
    checkOff: false,
    ...overrides,
  }
}

const noOpen = () => {}

const endedRow = (overrides: Partial<SwitcherRow> = {}): SwitcherRow =>
  row({ status: 'ended', section: 'ended', workspace: '/home/you/old', ...overrides })

// SessionProbe renders the id it landed on, so navigation assertions read the
// route instead of guessing what a bare MemoryRouter did.
function SessionProbe() {
  const { sessionId = '' } = useParams()
  return <div data-testid="session-view">{sessionId}</div>
}

// stubFacts answers the providers' bootstrap calls; each rendering test also
// awaits one findBy so the settled AuthProvider fetch lands inside act.
function stubFacts() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      if (String(url) === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
      return Response.json([])
    }),
  )
}

// needsInputDialog is one attention digest row with an open dialog, the same
// shape GET /api/attention answers with.
const needsInputDialog = [
  {
    sessionId: '01A',
    pid: 1,
    openInteractions: 1,
    running: false,
    idle: true,
    dialogId: 3,
    dialogPrompt: 'Allow write access?',
    dialogAt: 1_000,
  },
]

describe('SwitcherRows', () => {
  beforeEach(() => {
    localStorage.clear()
    resetLedger()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // tree mounts the rows under the providers plus the live-session route, so
  // resume navigation reads the URL it landed on like MobileHome's own tests.
  function tree(rows: SwitcherRow[], onOpen = noOpen) {
    return (
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <Routes>
                <Route path="/" element={<SwitcherRows rows={rows} onOpen={onOpen} />} />
                <Route path="/s/:sessionId" element={<SessionProbe />} />
              </Routes>
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>
    )
  }

  function renderRows(rows: SwitcherRow[], onOpen = noOpen) {
    return render(tree(rows, onOpen))
  }

  // sectionOfRow reads the rendered order: headings and rows are siblings, so
  // the last heading before a row names its section, count included.
  function sectionOfRow(container: HTMLElement, sessionId: string): string | null {
    let heading: string | null = null
    const selector = '.rail-section-title, [data-session-id]'
    for (const el of container.querySelectorAll<HTMLElement>(selector)) {
      if (el.classList.contains('rail-section-title')) heading = el.textContent
      else if (el.dataset.sessionId === sessionId) return heading
    }
    return null
  }

  // pressLong holds the row past the rename threshold on fake timers, then
  // releases the way a finger would: pointerup, and a click retargeted to the
  // rows container because the row itself was replaced mid-hold.
  async function pressLong(element: Element) {
    const user = userEvent.setup()
    const container = element.closest('.switcher-rows')!
    vi.useFakeTimers()
    act(() => {
      element.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerId: 1 }),
      )
    })
    await act(() => vi.advanceTimersByTimeAsync(500))
    vi.useRealTimers()
    act(() => {
      element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      container.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    return user
  }

  // fetchSpyCalled reads the current stub, whichever test installed it.
  function fetchSpyCalled(path: string): boolean {
    return (fetch as ReturnType<typeof vi.fn>).mock.calls.some(
      ([u]) => String(u).split('?')[0] === path,
    )
  }

  it('renames through long-press into swarm storage', async () => {
    const fetchSpy = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      if (String(url).endsWith('/title')) {
        return new Response(null, { status: 204 })
      }
      if (String(url) === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
      return Response.json([])
    })
    vi.stubGlobal('fetch', fetchSpy)
    const onOpen = vi.fn()

    renderRows([row()], onOpen)
    await pressLong(screen.getByRole('listitem'))

    // the hold opened the editor and suppressed the tap that opens the session
    const input = await screen.findByDisplayValue('project')
    expect(screen.getByTestId('rename-01A')).toBeInTheDocument()
    expect(onOpen).not.toHaveBeenCalled()

    const user = userEvent.setup()
    await user.clear(input)
    await user.type(input, 'couch reading')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await vi.waitFor(() => {
      const titles = fetchSpy.mock.calls.filter(([u]) => String(u).endsWith('/title'))
      expect(titles).toHaveLength(1)
      expect(JSON.parse(String(titles[0]![1]?.body))).toEqual({ title: 'couch reading' })
    })
  })

  it('rename action opens the same editor as long-press', async () => {
    stubFacts()
    renderRows([row()])
    await screen.findByText('project')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Rename' }))

    // the same keyed editor a long-press opens, seeded with the row's label
    expect(await screen.findByTestId('rename-01A')).toBeInTheDocument()
    expect(screen.getByDisplayValue('project')).toBeInTheDocument()
  })

  it('never offers a check-off on waiting rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url) === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        return Response.json([])
      }),
    )

    renderRows([row({ status: 'waiting', section: 'awaiting', reason: 'waiting for a prompt' })])
    await screen.findByText('waiting')

    // neutral waiting badge, no actionable control beside it
    expect(screen.queryByRole('button', { name: /reviewed/ })).not.toBeInTheDocument()
  })

  it('offers the check-off on live needs-input rows and counts them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const path = String(url).split('?')[0]
        if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        if (path === '/api/attention') return Response.json(needsInputDialog)
        return Response.json([])
      }),
    )

    renderRows([
      row({
        sessionId: '01A',
        section: 'needs-input',
        needsInput: true,
        reason: 'Allow write access?',
        checkOff: true,
      }),
      row({ sessionId: '01B', label: 'other' }),
    ])

    // the badge and the check-off both ride the digest; only the dialog row
    await screen.findByText('input')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /reviewed/ }))

    // the check-off landed in the persisted ledger, so the row stays settled
    await vi.waitFor(() => {
      const ledger = JSON.parse(localStorage.getItem('swarm.attention.v1')!)
      expect(ledger.dialogs['01A']['1:3']).toBeGreaterThan(0)
    })
    expect(screen.queryByRole('button', { name: /reviewed/ })).not.toBeInTheDocument()
  })

  it('badges queued prompts beside the status', async () => {
    stubFacts()
    renderRows([row({ sessionId: '01A', queued: 2 }), row({ sessionId: '01B', label: 'other' })])
    await screen.findByText('project')

    expect(screen.getByText('2 queued')).toBeInTheDocument()
    // zero-state rows stay badge-less
    expect(screen.queryByText('0 queued')).not.toBeInTheDocument()
  })

  it('heads each non-empty section with its count', async () => {
    stubFacts()
    const { container } = renderRows([
      row({ sessionId: '01A', section: 'needs-input' }),
      row({ sessionId: '01B', label: 'other', section: 'working' }),
      row({ sessionId: '01C', label: 'old', status: 'ended', section: 'ended' }),
    ])

    await screen.findByText('Needs input')
    expect(sectionOfRow(container, '01A')).toBe('Needs input (1)')
    expect(sectionOfRow(container, '01B')).toBe('Working (1)')
    expect(sectionOfRow(container, '01C')).toBe('Recent (1)')
  })

  it('moves rows under the right heading as attention shifts', async () => {
    stubFacts()
    const view = renderRows([
      row({ sessionId: '01A', status: 'waiting', section: 'awaiting' }),
      row({
        sessionId: '01B',
        label: 'other',
        needsInput: true,
        reason: 'Allow write access?',
        checkOff: true,
        section: 'needs-input',
      }),
    ])
    await screen.findByText('Needs input')
    // each row sits under its own shared heading
    expect(sectionOfRow(view.container, '01A')).toBe('Waiting (1)')
    expect(sectionOfRow(view.container, '01B')).toBe('Needs input (1)')

    // one session starts running while the other's dialog closes into its turn
    view.rerender(
      tree([
        row({ sessionId: '01A', status: 'running', section: 'working' }),
        row({ sessionId: '01B', label: 'other', status: 'running', section: 'working' }),
      ]),
    )
    await screen.findByText('Working')
    expect(sectionOfRow(view.container, '01A')).toBe('Working (2)')
    expect(sectionOfRow(view.container, '01B')).toBe('Working (2)')
    expect(screen.queryByText('Needs input')).not.toBeInTheDocument()
  })

  it('stops through the endpoint and refreshes rows', async () => {
    let release: (() => void) | null = null
    const fetchSpy = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const path = String(url).split('?')[0]
      if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
      if (path === '/api/sessions/01A/stop') {
        // held open until the test releases it, so the busy state is watchable
        return new Promise<Response>((resolve) => {
          release = () => resolve(new Response(null, { status: 204 }))
        })
      }
      return Response.json([])
    })
    vi.stubGlobal('fetch', fetchSpy)

    renderRows([row()])
    await screen.findByText('project')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    // the first click only arms, in the shared danger variant
    const armed = screen.getByRole('button', { name: 'Stop?' })
    expect(armed).toHaveClass('danger', 'armed')
    await user.click(armed)
    expect(await screen.findByRole('button', { name: 'Stopping…' })).toBeDisabled()

    const listingGets = () =>
      fetchSpy.mock.calls.filter(([u]) => String(u).split('?')[0] === '/api/sessions').length
    const before = listingGets()
    await act(async () => {
      release?.()
    })

    await vi.waitFor(() => {
      const stops = fetchSpy.mock.calls.filter(
        ([u, init]) => String(u) === '/api/sessions/01A/stop' && init?.method === 'POST',
      )
      expect(stops).toHaveLength(1)
      expect(listingGets()).toBeGreaterThan(before)
    })
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
  })

  it('renders a refused stop inline on the row', async () => {
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url).split('?')[0]
      if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
      if (path === '/api/sessions/01A/stop' && init?.method === 'POST') {
        return Response.json(
          { error: 'unavailable', message: 'session is shutting down' },
          {
            status: 409,
          },
        )
      }
      return Response.json([])
    })
    vi.stubGlobal('fetch', fetchSpy)

    renderRows([row()])
    await screen.findByText('project')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    await user.click(screen.getByRole('button', { name: 'Stop?' }))

    // desktop's error-text style, rendered inline on the row
    expect(await screen.findByText('unavailable: session is shutting down')).toHaveClass(
      'error-text',
    )
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
  })

  it('resets the armed stop when a poll re-renders rows', async () => {
    stubFacts()
    const view = renderRows([row()])
    await screen.findByText('project')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByRole('button', { name: 'Stop?' })).toBeInTheDocument()

    // a listing poll rebuilds every row object, same facts included
    view.rerender(tree([row()]))
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByRole('button', { name: 'Stop?' })).toBeInTheDocument()
    expect(fetchSpyCalled('/api/sessions/01A/stop')).toBe(false)
  })

  it('resets the armed stop when the sheet scrolls', async () => {
    stubFacts()
    const { container } = renderRows([row()])
    await screen.findByText('project')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByRole('button', { name: 'Stop?' })).toBeInTheDocument()

    act(() => {
      container.querySelector('.switcher-rows')!.dispatchEvent(new Event('scroll'))
    })
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
  })

  it('offers resume only on ended rows with a workspace', async () => {
    stubFacts()
    renderRows([
      row(),
      endedRow({ sessionId: '01C', label: 'old' }),
      endedRow({ sessionId: '01D', label: 'lost', workspace: undefined }),
    ])
    await screen.findByText('project')

    // the live row acts, the recorded ended row resumes, the workspace-less
    // one offers nothing; rename needs neither seat state nor a workspace, so
    // it lands on every row
    expect(screen.getAllByRole('button', { name: 'Rename' })).toHaveLength(3)
    expect(screen.getAllByRole('button', { name: 'Settings' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Resume' })).toHaveLength(1)
  })

  it('resumes an ended row into the live session', async () => {
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url).split('?')[0]
      if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
      if (path === '/api/sessions' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({
          workspace: '/home/you/old',
          mode: 'resume',
          target: '01C',
        })
        return Response.json({ sessionId: '01RESUMED000000000', pid: 42 })
      }
      return Response.json([])
    })
    vi.stubGlobal('fetch', fetchSpy)

    renderRows([endedRow({ sessionId: '01C', label: 'old' })])
    await screen.findByText('old')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Resume' }))

    expect(await screen.findByTestId('session-view')).toHaveTextContent('01RESUMED000000000')
  })

  it('opens one pushed settings screen', async () => {
    stubFacts()
    renderRows([row(), row({ sessionId: '01B', label: 'other' })])
    await screen.findByText('project')

    const user = userEvent.setup()
    await user.click(screen.getAllByRole('button', { name: 'Settings' })[1]!)

    // one pushed screen, riding the tapped row's session id
    expect(await screen.findByRole('dialog', { name: 'Agent settings' })).toBeInTheDocument()
    expect(screen.getAllByRole('dialog', { name: 'Agent settings' })).toHaveLength(1)
    await vi.waitFor(() => {
      expect(fetchSpyCalled('/api/sessions/01B/settings')).toBe(true)
      expect(fetchSpyCalled('/api/sessions/01A/settings')).toBe(false)
    })

    // tapping the other row rebinds the same sheet instead of stacking one
    await user.click(screen.getAllByRole('button', { name: 'Settings' })[0]!)
    await vi.waitFor(() => {
      expect(fetchSpyCalled('/api/sessions/01A/settings')).toBe(true)
    })
    expect(screen.getAllByRole('dialog', { name: 'Agent settings' })).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: '← Back' }))
    expect(screen.queryByRole('dialog', { name: 'Agent settings' })).not.toBeInTheDocument()
  })

  it('tapping an action never opens the row', async () => {
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url).split('?')[0]
      if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
      if (path === '/api/sessions' && init?.method === 'POST') {
        return Response.json({ sessionId: '01RESUMED000000000', pid: 42 })
      }
      return Response.json([])
    })
    vi.stubGlobal('fetch', fetchSpy)
    const onOpen = vi.fn()

    renderRows([row(), endedRow({ sessionId: '01C', label: 'old' })], onOpen)
    await screen.findByText('project')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    await user.click(screen.getAllByRole('button', { name: 'Rename' })[0]!)
    await user.click(screen.getByRole('button', { name: 'Resume' }))

    expect(onOpen).not.toHaveBeenCalled()
  })

  it('holding an action never opens rename', async () => {
    stubFacts()
    const onOpen = vi.fn()
    renderRows([row()], onOpen)
    await screen.findByText('project')

    await pressLong(screen.getByRole('button', { name: 'Stop' }))
    await pressLong(screen.getByRole('button', { name: 'Rename' }))

    expect(screen.queryByDisplayValue('project')).not.toBeInTheDocument()
    expect(onOpen).not.toHaveBeenCalled()
  })
})

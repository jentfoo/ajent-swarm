import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useParams } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SwitcherRows } from './SwitcherRows'
import { ChainEditorScreen } from './ChainScreens'
import { QueueScreen } from './QueueScreens'
import { pointAt } from '../test/elementFromPoint'
import type { SwitcherRow } from './switcher'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'

// The switcher's interactive contract at its breakpoint: rows group under
// muted desktop-rail headings, long-press opens the shared session menu
// (queue follow-up, chain after, rename, stop) carrying the row's rename and
// chain actions, and the hold suppresses its release tap, a held
// drag chains one row onto another, awaiting rows never offer a check-off,
// live needs-input rows offer one backed by the digest, stop arms before it
// fires and holds across listing polls of the same instance (a relaunch
// swaps the row), and the trailing actions hit their endpoints and rebind a
// single pushed settings screen without tripping the row's own gestures.

function row(overrides: Partial<SwitcherRow> = {}): SwitcherRow {
  return {
    sessionId: '01A',
    label: 'project',
    status: 'idle',
    section: 'working',
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

// stubFacts answers the providers' bootstrap calls, each rendering test also
// awaits one findBy so the settled AuthProvider fetch lands inside act.
function stubFacts() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      if (String(url) === '/api/me')
        return Response.json({ username: 'you', home: '/home/you', via: 'cookie' })
      return Response.json([])
    }),
  )
}

// needsInputDialog is one attention digest row with an open dialog, the same
// shape GET /api/attention answers with, settled flips it to the settled read
// the server answers after one acknowledgment lands.
let attention: unknown[]
const needsInputDialog = () => [
  {
    sessionId: '01A',
    pid: 1,
    openInteractions: 1,
    running: false,
    idle: true,
    dialogId: 3,
    dialogPrompt: 'Allow write access?',
    dialogAt: 1_000,
    kind: 'needs-input',
    reason: 'Allow write access?',
    since: 1_000,
  },
]
const settledDialog = () => [
  {
    sessionId: '01A',
    pid: 1,
    openInteractions: 1,
    running: false,
    idle: true,
    dialogId: 3,
    dialogPrompt: 'Allow write access?',
    dialogAt: 1_000,
    ackedDialog: true,
    kind: 'awaiting',
    reason: 'waiting for a prompt',
  },
]

describe('SwitcherRows', () => {
  // live rows carry a drag config, so any stray move resolves the element
  // under the pointer: answer nothing until a drag test names a row
  const under = pointAt(null)

  beforeEach(() => {
    localStorage.clear()
    attention = needsInputDialog()
  })

  afterEach(() => {
    under.set(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
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
              <ChainEditorScreen />
              <QueueScreen />
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

  // pressLong holds the row past the hold threshold on fake timers, then
  // releases the way a finger would: pointerup, and a click retargeted to the
  // rows container because the row itself was replaced mid-hold. The hold
  // opens the session menu anchored at the press point.
  async function pressLong(element: Element) {
    const user = userEvent.setup()
    const container = element.closest('.switcher-rows')!
    vi.useFakeTimers()
    act(() => {
      element.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          isPrimary: true,
          pointerId: 1,
          clientX: 20,
          clientY: 30,
        }),
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

  // dragChain holds one row onto its threshold, moves the pointer (the hold
  // converts into a drag) and releases over the row a mocked elementFromPoint
  // reports under the finger.
  async function dragChain(source: Element, target: Element | null) {
    vi.useFakeTimers()
    act(() => {
      source.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          isPrimary: true,
          pointerId: 1,
          clientX: 0,
          clientY: 0,
        }),
      )
    })
    await act(() => vi.advanceTimersByTimeAsync(500))
    under.set(target)
    act(() => {
      source.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          isPrimary: true,
          pointerId: 1,
          clientX: 40,
          clientY: 0,
        }),
      )
    })
    vi.useRealTimers()
    act(() => {
      source.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          isPrimary: true,
          pointerId: 1,
          clientX: 40,
          clientY: 0,
        }),
      )
    })
  }

  // fetchSpyCalled reads the current stub, whichever test installed it.
  function fetchSpyCalled(path: string): boolean {
    return (fetch as ReturnType<typeof vi.fn>).mock.calls.some(
      ([u]) => String(u).split('?')[0] === path,
    )
  }

  it('renames through the long-press menu into swarm storage', async () => {
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

    // the hold opened the menu (not the row) and suppressed the release tap
    const user = await pressLongMenu('project')
    expect(onOpen).not.toHaveBeenCalled()
    const input = await screen.findByDisplayValue('project')
    expect(screen.getByTestId('rename-01A')).toBeInTheDocument()

    await user.clear(input)
    await user.type(input, 'couch reading')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await vi.waitFor(() => {
      const titles = fetchSpy.mock.calls.filter(([u]) => String(u).endsWith('/title'))
      expect(titles).toHaveLength(1)
      expect(JSON.parse(String(titles[0]![1]?.body))).toEqual({ title: 'couch reading' })
    })
  })

  // pressLongMenu taps the rename entry of the menu a pressLong opened over
  // the named row, returning the user for the editor it opens.
  async function pressLongMenu(label: string) {
    const menu = screen.getByRole('menu')
    const user = userEvent.setup()
    await user.click(within(menu).getByRole('menuitem', { name: 'Rename…' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByText(label)).toBeInTheDocument()
    return user
  }

  it('queues a follow-up from the long-press menu', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const path = String(url).split('?')[0]
        if (path === '/api/me')
          return Response.json({ username: 'you', home: '/home/you', via: 'cookie' })
        if (path === '/api/sessions')
          return Response.json([{ sessionId: '01A', name: 'project', state: 'online' }])
        return Response.json([])
      }),
    )
    renderRows([row()])
    await screen.findByText('project')

    await pressLong(screen.getByRole('listitem'))
    const menu = screen.getByRole('menu')
    // the desktop right-click entries all ride the held menu
    expect(within(menu).getByRole('menuitem', { name: 'Queue follow up session…' }))
    expect(within(menu).getByRole('menuitem', { name: 'Chain after…' }))
    expect(within(menu).getByRole('menuitem', { name: 'Rename…' }))
    expect(within(menu).getByRole('menuitem', { name: 'Stop session' }))

    const user = userEvent.setup()
    await user.click(within(menu).getByRole('menuitem', { name: 'Queue follow up session…' }))
    expect(
      await screen.findByRole('dialog', { name: 'Queue follow up after project' }),
    ).toBeInTheDocument()
  })

  it('back closes the rename editor alone', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    stubFacts()
    renderRows([row()])
    await screen.findByText('project')

    // the menu's rename entry opens the same keyed editor, seeded with the
    // row's label
    await pressLong(screen.getByRole('listitem'))
    await pressLongMenu('project')
    expect(await screen.findByTestId('rename-01A')).toBeInTheDocument()

    // the platform back gesture peels the editor, rows intact, and its
    // unmount consumes the history entry it opened
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(screen.queryByTestId('rename-01A')).not.toBeInTheDocument()
    expect(screen.getByText('project')).toBeInTheDocument()
    expect(back).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new PopStateEvent('popstate')) // settle the consume
  })

  it('never offers a check-off on waiting rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url) === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        return Response.json([])
      }),
    )

    renderRows([row({ status: 'waiting', section: 'waiting', reason: 'waiting for a prompt' })])
    await screen.findByText('waiting')

    // neutral waiting badge, no actionable control beside it
    expect(screen.queryByRole('button', { name: /reviewed/ })).not.toBeInTheDocument()
  })

  it('offers the check-off on live needs-input rows and counts them', async () => {
    const ackBodies: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const path = String(url).split('?')[0]
        if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        if (path === '/api/attention') return Response.json(attention)
        if (path === '/api/attention/ack') {
          // the server settles the ack, so the digest re-reads settled
          ackBodies.push(String(init?.body))
          attention = settledDialog()
          return new Response(null, { status: 204 })
        }
        return Response.json([])
      }),
    )

    renderRows([
      row({
        sessionId: '01A',
        status: 'input',
        section: 'needs',
        reason: 'Allow write access?',
        checkOff: true,
      }),
      row({ sessionId: '01B', label: 'other' }),
    ])

    // the badge and the check-off both ride the digest, only the dialog row
    await screen.findByText('needs input')
    const user = userEvent.setup()
    // the check-off button lands a fetch tick after the badge, so wait for it
    await user.click(await screen.findByRole('button', { name: /reviewed/ }))

    // the check-off posted one dialog acknowledgment with its pid scope, and
    // the settled digest re-read leaves the row without a check-off
    await vi.waitFor(() => {
      expect(ackBodies).toEqual(['{"sessionId":"01A","pid":1,"dialogId":3}'])
    })
    await vi.waitFor(() => {
      expect(screen.queryByRole('button', { name: /reviewed/ })).not.toBeInTheDocument()
    })
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
      row({ sessionId: '01A', section: 'needs' }),
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
      row({ sessionId: '01A', status: 'waiting', section: 'waiting' }),
      row({
        sessionId: '01B',
        label: 'other',
        status: 'input',
        reason: 'Allow write access?',
        checkOff: true,
        section: 'needs',
      }),
    ])
    await screen.findByText('Needs input')
    // each row sits under its own queue, badged by its own state
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
    expect(await screen.findByText('session is shutting down')).toHaveClass('error-text')
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
  })

  it('keeps the armed stop across listing polls', async () => {
    stubFacts()
    const view = renderRows([row()])
    await screen.findByText('project')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByRole('button', { name: 'Stop?' })).toBeInTheDocument()

    // a listing poll rebuilds every row object, same instance included, the
    // arm must survive it or no human taps twice within one poll cadence
    view.rerender(tree([row()]))
    expect(screen.getByRole('button', { name: 'Stop?' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Stop?' }))
    expect(fetchSpyCalled('/api/sessions/01A/stop')).toBe(true)
  })

  it('resets the armed stop on an instance swap', async () => {
    stubFacts()
    const view = renderRows([row({ pid: 11 })])
    await screen.findByText('project')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByRole('button', { name: 'Stop?' })).toBeInTheDocument()

    // the same id relaunched under a fresh pid remounts the row disarmed
    view.rerender(tree([row({ pid: 12 })]))
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByRole('button', { name: 'Stop?' })).toBeInTheDocument()
    expect(fetchSpyCalled('/api/sessions/01A/stop')).toBe(false)
  })

  it('keeps the armed stop while the list scrolls it in view', async () => {
    stubFacts()
    const { container } = renderRows([row()])
    await screen.findByText('project')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByRole('button', { name: 'Stop?' })).toBeInTheDocument()

    // momentum tails and anchoring nudge the list without moving the row
    // out of sight: the confirm must survive them
    act(() => {
      container.querySelector('.switcher-rows')!.dispatchEvent(new Event('scroll'))
    })
    expect(screen.getByRole('button', { name: 'Stop?' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Stop?' }))
    expect(fetchSpyCalled('/api/sessions/01A/stop')).toBe(true)
  })

  it('resets the armed stop once the list scrolls it out of view', async () => {
    stubFacts()
    const { container } = renderRows([row()])
    await screen.findByText('project')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    const armed = screen.getByRole('button', { name: 'Stop?' })
    vi.spyOn(armed, 'getBoundingClientRect').mockReturnValue({
      width: 60,
      height: 40,
      top: window.innerHeight + 50,
      bottom: window.innerHeight + 90,
      left: 10,
      right: 70,
      x: 10,
      y: window.innerHeight + 50,
      toJSON: () => ({}),
    } as DOMRect)

    act(() => {
      container.querySelector('.switcher-rows')!.dispatchEvent(new Event('scroll'))
    })
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByRole('button', { name: 'Stop?' })).toBeInTheDocument()
    expect(fetchSpyCalled('/api/sessions/01A/stop')).toBe(false)
  })

  it('shows the workspace path like the desktop rail', async () => {
    stubFacts()
    const { container } = renderRows([
      row({ workspace: '/home/you/proj' }),
      row({ sessionId: '01B', label: 'bare' }),
    ])
    await screen.findByText('project')

    // one tilde-folded path under the titled row, none without a workspace
    const paths = container.querySelectorAll('.rail-path')
    expect(paths).toHaveLength(1)
    expect(paths[0]).toHaveTextContent('~/proj')
    expect(paths[0]).toHaveAttribute('title', '/home/you/proj')
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
    // one offers nothing, rename and chaining live in the long-press menu
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument()
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

    // tapping the other row rebinds the same pushed screen instead of stacking one
    await user.click(screen.getAllByRole('button', { name: 'Settings' })[0]!)
    await vi.waitFor(() => {
      expect(fetchSpyCalled('/api/sessions/01A/settings')).toBe(true)
    })
    expect(screen.getAllByRole('dialog', { name: 'Agent settings' })).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: '← Back' }))
    expect(screen.queryByRole('dialog', { name: 'Agent settings' })).not.toBeInTheDocument()
  })

  it('chains after a row through the pushed picker and editor', async () => {
    const fetchSpy = vi.fn(async (url: string | URL) => {
      const path = String(url).split('?')[0]
      if (path === '/api/me')
        return Response.json({ username: 'you', home: '/home/you', via: 'cookie' })
      if (path === '/api/sessions')
        return Response.json([
          { sessionId: '01A', name: 'project', state: 'online' },
          { sessionId: '01B', name: 'other', state: 'online' },
        ])
      if (path === '/api/attention') return Response.json(attention)
      if (path.endsWith('/entries')) return Response.json({ entries: [] })
      return Response.json([])
    })
    vi.stubGlobal('fetch', fetchSpy)
    renderRows([row(), row({ sessionId: '01B', label: 'other' })])
    await screen.findByText('project')

    const user = userEvent.setup()
    // the chain action rides the long-press menu on every live row
    await pressLong(screen.getAllByRole('listitem')[0]!)
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Chain after…' }),
    )

    // the target picker pushes as its own screen, the new-session row first
    // and the existing targets excluding the parent row behind it
    const picker = await screen.findByRole('dialog', { name: 'Chain after this session' })
    const targets = within(picker).getAllByRole('listitem')
    expect(targets).toHaveLength(2)
    expect(targets[0]).toHaveTextContent('Start a new session…')
    expect(targets[1]).toHaveTextContent('other')

    await user.click(within(targets[1]).getByRole('button')) // the existing 'other' row
    // picking lands the draft and the editor screen takes over
    const editor = await screen.findByRole('dialog', { name: 'Chain other after project' })
    expect(
      screen.queryByRole('dialog', { name: 'Chain after this session' }),
    ).not.toBeInTheDocument()

    // typed prompts never drop silently: back asks first, discard closes
    await user.type(within(editor).getByLabelText(/Prompt for other/), 'typed')
    await user.click(screen.getByRole('button', { name: '← Back' }))
    const confirm = await screen.findByRole('dialog', { name: 'Discard changes?' })
    await user.click(within(confirm).getByRole('button', { name: 'Keep editing' }))
    expect(screen.getByRole('dialog', { name: 'Chain other after project' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '← Back' }))
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Discard changes?' })).getByRole('button', {
        name: 'Discard',
      }),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('queues a follow-up from the picker screen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const path = String(url).split('?')[0]
        if (path === '/api/me')
          return Response.json({ username: 'you', home: '/home/you', via: 'cookie' })
        if (path === '/api/sessions')
          return Response.json([{ sessionId: '01A', name: 'project', state: 'online' }])
        return Response.json([])
      }),
    )
    renderRows([row(), row({ sessionId: '01B', label: 'other' })])
    await screen.findByText('project')

    await pressLong(screen.getAllByRole('listitem')[0]!)
    const user = userEvent.setup()
    await user.click(
      within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Chain after…' }),
    )
    const picker = await screen.findByRole('dialog', { name: 'Chain after this session' })

    // the leading row skips target picking: it opens the shared follow-up
    // form with this row as the parent
    await user.click(within(picker).getByText('Start a new session…'))
    expect(
      screen.queryByRole('dialog', { name: 'Chain after this session' }),
    ).not.toBeInTheDocument()
    expect(
      await screen.findByRole('dialog', { name: 'Queue follow up after project' }),
    ).toBeInTheDocument()
  })

  it('chains one row onto another by held drag', async () => {
    const fetchSpy = vi.fn(async (url: string | URL) => {
      const path = String(url).split('?')[0]
      if (path === '/api/me')
        return Response.json({ username: 'you', home: '/home/you', via: 'cookie' })
      if (path === '/api/sessions')
        return Response.json([
          { sessionId: '01A', name: 'project', state: 'online' },
          { sessionId: '01B', name: 'other', state: 'online' },
        ])
      if (path === '/api/attention') return Response.json(attention)
      if (path.endsWith('/entries')) return Response.json({ entries: [] })
      return Response.json([])
    })
    vi.stubGlobal('fetch', fetchSpy)
    renderRows([row(), row({ sessionId: '01B', label: 'other' })])
    await screen.findByText('project')

    const source = document.querySelector('[data-session-id="01A"]')!
    const target = document.querySelector('[data-session-id="01B"]')!
    vi.useFakeTimers()
    act(() => {
      source.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          isPrimary: true,
          pointerId: 1,
          clientX: 0,
          clientY: 0,
        }),
      )
    })
    await act(() => vi.advanceTimersByTimeAsync(500))
    // the hold opened the menu, movement converts the same press into a drag
    expect(screen.getByRole('menu')).toBeInTheDocument()
    under.set(target)
    act(() => {
      source.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          isPrimary: true,
          pointerId: 1,
          clientX: 40,
          clientY: 0,
        }),
      )
    })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(target).toHaveClass('chain-target')
    expect(source).toHaveClass('chain-source')

    vi.useRealTimers()
    act(() => {
      source.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          isPrimary: true,
          pointerId: 1,
          clientX: 40,
          clientY: 0,
        }),
      )
    })

    // the dropped-on row is the parent, the dragged row queues after it, the
    // same drop the desktop rail takes
    expect(await screen.findByRole('dialog', { name: 'Chain project after other' }))
    expect(target).not.toHaveClass('chain-target')
  })

  it('refuses a held-drag drop onto ended rows', async () => {
    stubFacts()
    renderRows([row(), endedRow({ sessionId: '01C', label: 'old' })])
    await screen.findByText('project')

    const source = document.querySelector('[data-session-id="01A"]')!
    const ended = document.querySelector('[data-session-id="01C"]')!
    await dragChain(source, ended)

    // the Recent tail never chains: no highlight while over it, no draft after
    expect(ended).not.toHaveClass('chain-target')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('ends the drag when its row leaves the listing', async () => {
    stubFacts()
    const view = renderRows([row(), row({ sessionId: '01B', label: 'other' })])
    await screen.findByText('project')

    const source = document.querySelector('[data-session-id="01A"]')!
    const target = document.querySelector('[data-session-id="01B"]')!
    vi.useFakeTimers()
    act(() => {
      source.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          isPrimary: true,
          pointerId: 1,
          clientX: 0,
          clientY: 0,
        }),
      )
    })
    await act(() => vi.advanceTimersByTimeAsync(500))
    under.set(target)
    act(() => {
      source.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          isPrimary: true,
          pointerId: 1,
          clientX: 40,
          clientY: 0,
        }),
      )
    })
    vi.useRealTimers()
    expect(target).toHaveClass('chain-target')

    // the dragged session drops off the listing mid-gesture: its unmount
    // ends the drag instead of stranding the target's highlight
    view.rerender(tree([row({ sessionId: '01B', label: 'other' })]))
    expect(document.querySelector('[data-session-id="01B"]')).not.toHaveClass('chain-target')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows a chained row queue role instead of the plain reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const path = String(url).split('?')[0]
        if (path === '/api/me')
          return Response.json({ username: 'you', home: '/home/you', via: 'cookie' })
        if (path === '/api/sessions')
          return Response.json([{ sessionId: '01A', name: 'project', state: 'online' }])
        if (path === '/api/attention')
          return Response.json([
            {
              sessionId: '01A',
              pid: 1,
              openInteractions: 0,
              running: false,
              idle: true,
              kind: 'awaiting',
              reason: 'waiting for a prompt',
              chainedOn: '01P',
              chainedOnId: 'chn_1',
            },
          ])
        return Response.json([])
      }),
    )
    renderRows([row({ sessionId: '01A', status: 'chained' })])
    await screen.findByText('project')
    await screen.findByText('queued behind 01P')
  })

  it('opens through the native Open control', async () => {
    stubFacts()
    const onOpen = vi.fn()
    renderRows([row()], onOpen)
    await screen.findByText('project')

    // the row's own keyboard path: focus the visible control, press Enter,
    // one open -- never the tap handler double-firing
    const openButton = within(screen.getByRole('listitem')).getByRole('button', { name: 'Open' })
    act(() => {
      openButton.focus()
    })
    await userEvent.setup().keyboard('{Enter}')

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect((onOpen.mock.calls[0]![0] as SwitcherRow).sessionId).toBe('01A')
  })

  it('offers menu actions without a long press', async () => {
    stubFacts()
    renderRows([row()])
    await screen.findByText('project')

    // the ⋯ trigger opens the shared session menu at the button, so rename,
    // queue follow-up and chain are reachable with a keyboard alone
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'More actions for project' }))

    const menu = screen.getByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'Rename…' })).toBeInTheDocument()
    expect(
      within(menu).getByRole('menuitem', { name: 'Queue follow up session…' }),
    ).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Chain after…' })).toBeInTheDocument()

    // the rename entry still lands the same keyed editor the long press opens
    await user.click(within(menu).getByRole('menuitem', { name: 'Rename…' }))
    expect(await screen.findByTestId('rename-01A')).toBeInTheDocument()
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
    await user.click(screen.getByRole('button', { name: 'Resume' }))

    expect(onOpen).not.toHaveBeenCalled()
  })

  it('holding an action never opens the menu', async () => {
    stubFacts()
    const onOpen = vi.fn()
    renderRows([row()], onOpen)
    await screen.findByText('project')

    await pressLong(screen.getByRole('button', { name: 'Stop' }))

    // the actions swallow the pointerdown, so no hold ever fires
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('project')).not.toBeInTheDocument()
    expect(onOpen).not.toHaveBeenCalled()
  })
})

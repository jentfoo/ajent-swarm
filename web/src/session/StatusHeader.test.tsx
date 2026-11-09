import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ModeMenu, StatusHeader } from './StatusHeader'
import type { CtlState, SessionInfo, SessionStatus } from '../api/types'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'
import { stubCoarsePointer } from '../test/matchMedia'
import { MockWebSocket } from '../test/mockWebSocket'

// The mode menu picks straight from the fixed upstream vocabulary through
// mode.set; a session without a gate renders no affordance at all. The header
// carries identity: the swarm listing's label beside the short session id.

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async (url: string | URL) => {
    if (String(url).endsWith('/api/me')) return Response.json({ username: 'you' })
    return Response.json([])
  })
  vi.stubGlobal('fetch', fetchMock)
  // SwarmProvider connects a socket on mount; a silent stand-in keeps jsdom
  // from attempting a real one
  vi.stubGlobal('WebSocket', MockWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function snapFor(overrides: Partial<CtlState> = {}): CtlState {
  return {
    session: { id: '01HWYSF8G2XK' },
    workspace: '/w',
    cwd: '/w',
    head: '',
    model: {
      key: 'p/m',
      short: '',
      window: 0,
      caps: { reasoning: false, images: false, parallelToolCalls: false },
    },
    permission: '',
    tools: [],
    usage: { turns: 0, total: zero(), child: zero(), estimatedTurns: 0 },
    context: { used: 0, window: 0, reserve: 0, compact: 0, estimated: false },
    running: false,
    idle: true,
    spinning: false,
    queued: 0,
    activity: [],
    status: {},
    seat: { held: false, yours: false },
    ...overrides,
  }
}

function zero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

describe('ModeMenu', () => {
  it('hides entirely when no gate exists', () => {
    render(<ModeMenu sessionId="01S" mode="" onToast={vi.fn()} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('marks the active level in the mode menu', async () => {
    const user = userEvent.setup()
    render(<ModeMenu sessionId="01S" mode="auto" onToast={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /mode: auto/ }))
    const items = screen.getAllByRole('menuitem')
    // the active level carries a visible marker, exactly one
    expect(items.filter((el) => el.textContent?.includes('current'))).toHaveLength(1)
  })

  it('sets a named level through the mode endpoint', async () => {
    const user = userEvent.setup()
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).endsWith('/mode')) return Response.json({ mode: 'allow-all' })
      throw new Error(`unexpected fetch ${String(url)}`)
    })
    const onToast = vi.fn()
    render(<ModeMenu sessionId="01S" mode="auto" onToast={onToast} />)

    await user.click(screen.getByRole('button', { name: /mode: auto/ }))
    await user.click(screen.getByRole('menuitem', { name: /allow-all/ }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/sessions/01S/mode')
    expect(JSON.parse(String(init.body))).toEqual({ mode: 'allow-all' })
    expect(onToast).not.toHaveBeenCalled()
  })

  it('surfaces a refusal as a toast and keeps the menu open', async () => {
    const user = userEvent.setup()
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).endsWith('/mode')) {
        return Response.json(
          { error: 'invalid_request', message: 'no gate on this session' },
          { status: 400 },
        )
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })
    const onToast = vi.fn()
    render(<ModeMenu sessionId="01S" mode="auto" onToast={onToast} />)

    await user.click(screen.getByRole('button', { name: /mode: auto/ }))
    await user.click(screen.getByRole('menuitem', { name: /allow-all/ }))

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith('invalid_request: no gate on this session', 'error'),
    )
  })

  it('announces the chip as a toggleable menu', async () => {
    const user = userEvent.setup()
    render(<ModeMenu sessionId="01S" mode="auto" onToast={vi.fn()} />)

    const chip = screen.getByRole('button', { name: /mode: auto/ })
    expect(chip).toHaveAttribute('aria-haspopup', 'menu')
    expect(chip).toHaveAttribute('aria-expanded', 'false')

    await user.click(chip)
    expect(chip).toHaveAttribute('aria-expanded', 'true')

    await user.click(chip)
    expect(chip).toHaveAttribute('aria-expanded', 'false')
  })

  it('closes on platform back for touch pointers', async () => {
    // the history-bound popover mounts only here; fine-pointer tests above run
    // with the setup's matchMedia stub and keep desktop's plain MenuPopover
    stubCoarsePointer()
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    try {
      const user = userEvent.setup()
      render(<ModeMenu sessionId="01S" mode="auto" onToast={vi.fn()} />)

      await user.click(screen.getByRole('button', { name: /mode: auto/ }))
      expect(screen.getByRole('menuitem', { name: /allow-read/ })).toBeInTheDocument()

      // the platform back gesture pops the menu's own history entry and closes it
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'))
      })
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      expect(back).toHaveBeenCalledTimes(1) // its own entry, not a router one
    } finally {
      back.mockRestore()
    }

    // settle the queued consume and leave unstamped ground behind
    window.dispatchEvent(new PopStateEvent('popstate'))
    window.history.replaceState(null, '', window.location.href)
  })
})

// headerTree mounts the header inside its providers, since identity reads the
// swarm listing and the badge reads the workspace attention model. A router
// wraps it because the workspace provider routes notification click-through.
function headerTree(snap: CtlState) {
  return (
    <MemoryRouter>
      <AuthProvider>
        <SwarmProvider>
          <WorkspaceProvider>
            <StatusHeader sessionId={snap.session.id} onToast={vi.fn()} snap={snap} />
          </WorkspaceProvider>
        </SwarmProvider>
      </AuthProvider>
    </MemoryRouter>
  )
}

describe('StatusHeader identity', () => {
  const ID = '01HWYSF8G2XKABCDEF'

  function listingRow(overrides: Partial<SessionStatus> = {}): SessionStatus {
    return {
      sessionId: ID,
      state: 'online',
      seatHeld: false,
      seatOurs: false,
      running: false,
      idle: true,
      queued: 0,
      openInteractions: 0,
      spawnedBy: 'swarm',
      ...overrides,
    }
  }

  function renderNamed(listing: SessionStatus[], session: SessionInfo = { id: ID }) {
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith('/api/sessions')) return Response.json(listing)
      return Response.json([])
    })
    return render(headerTree(snapFor({ session })))
  }

  it('shows the listing label beside the short session id', async () => {
    renderNamed([listingRow({ title: 'nightly sweep' })])

    expect(await screen.findByText('nightly sweep')).toBeInTheDocument()
    expect(screen.getByText('01HWYSF8…')).toHaveClass('header-session-id')
  })

  it('prefers the listing label over the snapshot name', async () => {
    renderNamed([listingRow({ title: 'stored title' })], { id: ID, name: 'agent name' })

    expect(await screen.findByText('stored title')).toBeInTheDocument()
    expect(screen.queryByText('agent name')).not.toBeInTheDocument()
  })

  it('shows the short id alone when no listing row exists', async () => {
    renderNamed([])

    expect(await screen.findByText('01HWYSF8…')).toBeInTheDocument()
    expect(document.querySelector('.header-session-id')).not.toBeInTheDocument()
  })
})

describe('StatusHeader badge', () => {
  const ID = '01BADGESOURCE0001'

  function renderBadged(snap: CtlState, attention: unknown[]) {
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith('/api/attention')) return Response.json(attention)
      return Response.json([])
    })
    return render(headerTree(snap))
  }

  it('badges a running turn', async () => {
    renderBadged(snapFor({ session: { id: ID }, running: true, idle: false }), [])

    const badge = await screen.findByText('running')
    expect(badge).toHaveClass('accent')
  })

  it('badges a resting session idle', async () => {
    renderBadged(snapFor({ session: { id: ID } }), [])

    expect(await screen.findByText('idle')).toBeInTheDocument()
    expect(screen.queryByText('running')).not.toBeInTheDocument()
  })

  it('flips to needs input while the turn still runs, like the switcher', async () => {
    // the digest carries the open dialog: a parked turn reads blocked on the
    // human, not making progress, exactly as the switcher rows rank it
    renderBadged(snapFor({ session: { id: ID }, running: true, idle: false }), [
      {
        sessionId: ID,
        openInteractions: 1,
        running: true,
        idle: false,
        dialogId: 4,
        dialogPrompt: 'allow write?',
        kind: 'needs-input',
        reason: 'allow write?',
      },
    ])

    const badge = await screen.findByText('needs input')
    expect(badge).toHaveClass('danger')
    expect(screen.queryByText('running')).not.toBeInTheDocument()
  })
})

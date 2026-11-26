import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StatusHeader } from './StatusHeader'
import type { CtlState, SessionInfo, SessionStatus } from '../api/types'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'
import { MockWebSocket } from '../test/mockWebSocket'

// The header carries identity: the swarm listing's label beside the short
// session id. The mode menu it renders has its own file, ui/ModeMenu.test.tsx.

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async (url: string | URL) => {
    if (String(url).endsWith('/api/me')) return Response.json({ username: 'you' })
    return Response.json([])
  })
  vi.stubGlobal('fetch', fetchMock)
  // SwarmProvider connects a socket on mount, a silent stand-in keeps jsdom
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

  it('sizes the session title through the shared page-title class', async () => {
    renderNamed([listingRow({ title: 'nightly sweep' })])

    // theme.css owns the scale; no inline body-size reset remains on titles
    const title = await screen.findByRole('heading', { level: 1, name: /nightly sweep/ })
    expect(title).toHaveClass('page-title')
    expect(title).not.toHaveAttribute('style')
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

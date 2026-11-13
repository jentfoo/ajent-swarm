import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SessionsHome from './SessionsHome'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { MockWebSocket } from '../test/mockWebSocket'
import { ChildState, type SessionStatus } from '../api/types'

// The sessions grid renders over the real provider stack with fetch and
// WebSocket stubs: cards carry shared stop wording instead of raw reasons,
// held seats badge while free ones stay quiet, the fact line drops
// placeholders for whatever is actually known, and stop arms before it fires.

function session(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId: '01A',
    state: ChildState.Online,
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

let sessionsReply: SessionStatus[]
let fetchSpy: ReturnType<typeof vi.fn>

// TileProbe shows the open list the workspace request carried, so tests can
// assert what a grid selection tiles without mounting the real workspace.
function TileProbe() {
  const [params] = useSearchParams()
  return <div>tiled {params.get('open')}</div>
}

describe('SessionsHome', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionsReply = [session()]
    fetchSpy = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const base = String(url)
        .replace(/^https?:\/\/[^/]+/, '')
        .split('?')[0]
      if (base === '/api/me')
        return Promise.resolve(Response.json({ username: 'you', via: 'cookie' }))
      if (base === '/api/sessions' && (!init?.method || init.method === 'GET')) {
        return Promise.resolve(Response.json(sessionsReply))
      }
      if (base === '/api/sessions/01A/stop') {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      if (
        base === '/api/attention' ||
        base === '/api/models/options' ||
        base === '/api/tools/options'
      ) {
        return Promise.resolve(Response.json([]))
      }
      throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${base}`)
    })
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function renderHome() {
    return render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <SwarmProvider>
            <Routes>
              <Route path="/" element={<SessionsHome />} />
              <Route path="/focused" element={<div>focused</div>} />
              <Route path="/tile" element={<TileProbe />} />
              <Route path="/s/:sessionId" element={<div>session</div>} />
            </Routes>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
  }

  function stopPosts(): unknown[][] {
    return fetchSpy.mock.calls.filter(
      ([u, init]) =>
        String(u).split('?')[0] === '/api/sessions/01A/stop' && init?.method === 'POST',
    )
  }

  it('styles the launch command as code with no backticks', async () => {
    sessionsReply = []
    renderHome()

    const empty = await screen.findByText(/no live sessions/i)
    expect(empty.textContent).toBe('No live sessions. Launch one or start ajent --serve yourself.')
    expect(empty.querySelector('code')).toHaveTextContent('ajent --serve')
  })

  it('badges held seats and stays quiet on free ones', async () => {
    sessionsReply = [
      session({ sessionId: '01A', seatHeld: true, seatHolder: 'tui', seatOurs: false }),
      session({ sessionId: '01B' }),
    ]
    renderHome()

    expect(await screen.findByText('seat: tui')).toBeInTheDocument()
    expect(screen.queryByText('seat free')).not.toBeInTheDocument()
  })

  it('summarizes the last stop in shared wording', async () => {
    sessionsReply = [
      session({ sessionId: '01A', lastStop: 'end_turn' }),
      session({ sessionId: '01B', lastStop: 'max_tokens' }),
    ]
    renderHome()

    expect(await screen.findByText('turn complete')).toBeInTheDocument()
    expect(screen.getByText('stopped: max tokens')).toBeInTheDocument()
    expect(screen.queryByText(/last stop:/)).not.toBeInTheDocument()
  })

  it('keeps the failed turn prefix for stop errors', async () => {
    sessionsReply = [session({ sessionId: '01A', lastStop: 'error', lastStopErr: 'boom' })]
    renderHome()

    expect(await screen.findByText('last turn failed: boom')).toBeInTheDocument()
  })

  it('renders the exit note on ended cards', async () => {
    sessionsReply = [
      session({ sessionId: '01A', state: ChildState.Exited, detail: 'ended on its own' }),
    ]
    renderHome()

    expect(await screen.findByText('ended on its own')).toBeInTheDocument()
  })

  it('renders only what the fact line knows', async () => {
    sessionsReply = [
      session({ sessionId: '01A' }),
      session({ sessionId: '01B', workspace: '/home/you/repo' }),
      session({ sessionId: '01C', model: 'p/m', workspace: '/repo' }),
    ]
    renderHome()

    await screen.findByText('p/m · repo')
    expect(screen.queryByText(/model unknown/)).not.toBeInTheDocument()
    // the fact line disappears when neither model nor workspace is known
    const cardA = screen.getByRole('checkbox', { name: 'Select 01A for tiling' }).closest('.card')!
    expect(cardA.querySelector('.muted')).toBeNull()
    expect(screen.getByText('repo')).toBeInTheDocument()
  })

  it('arms the card stop in the danger variant before firing', async () => {
    renderHome()
    const user = userEvent.setup()
    const stop = await screen.findByRole('button', { name: 'Stop' })
    expect(stop).toHaveClass('danger')

    await user.click(stop)
    expect(screen.getByRole('button', { name: 'Stop?' })).toHaveClass('danger', 'armed')
    expect(stopPosts()).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Stop?' }))
    await vi.waitFor(() => expect(stopPosts()).toHaveLength(1))
  })

  it('disarms the card stop on blur', async () => {
    renderHome()
    const user = userEvent.setup()
    const stop = await screen.findByRole('button', { name: 'Stop' })

    await user.click(stop)
    expect(screen.getByRole('button', { name: 'Stop?' })).toBeInTheDocument()

    // focus moving on reads as a changed mind: the arm drops, never fires
    await user.tab()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByRole('button', { name: 'Stop?' })).toBeInTheDocument()
    expect(stopPosts()).toHaveLength(0)
  })

  it('keeps twin instance selection apart and tiles both', async () => {
    sessionsReply = [
      session({ sessionId: '01A', pid: 101 }),
      session({ sessionId: '01A', pid: 202, running: true, idle: false }),
    ]
    renderHome()
    const user = userEvent.setup()

    // twin rows badge their pids so the cards stay tellable apart
    expect(await screen.findByText('pid 101')).toBeInTheDocument()
    expect(screen.getByText('pid 202')).toBeInTheDocument()

    const first = screen.getByRole('checkbox', { name: 'Select 01A (pid 101) for tiling' })
    const second = screen.getByRole('checkbox', { name: 'Select 01A (pid 202) for tiling' })
    await user.click(first)
    expect(first).toBeChecked()
    expect(second).not.toBeChecked()

    // the tile request repeats the session id, once per selected instance
    await user.click(second)
    await user.click(screen.getByRole('button', { name: 'Open workspace' }))
    expect(await screen.findByText('tiled 01A,01A')).toBeInTheDocument()
  })
})

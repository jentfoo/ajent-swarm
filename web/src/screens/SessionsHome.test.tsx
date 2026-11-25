import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SessionsHome from './SessionsHome'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'
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
            <WorkspaceProvider>
              <Routes>
                <Route path="/" element={<SessionsHome />} />
                <Route path="/focused" element={<div>focused</div>} />
                <Route path="/tile" element={<TileProbe />} />
                <Route path="/s/:sessionId" element={<div>session</div>} />
              </Routes>
            </WorkspaceProvider>
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

  it('sizes the page title through the shared class, no inline override', () => {
    renderHome()

    const title = screen.getByRole('heading', { level: 1, name: 'Sessions' })
    expect(title).toHaveClass('page-title')
    // theme.css owns the scale; the old body-size inline reset is gone
    expect(title).not.toHaveAttribute('style')
  })

  it('shows a loading line until the roster lands, then the empty state', async () => {
    let release!: (r: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const base = String(url)
          .replace(/^https?:\/\/[^/]+/, '')
          .split('?')[0]
        if (base === '/api/me')
          return Promise.resolve(Response.json({ username: 'you', via: 'cookie' }))
        if (base === '/api/sessions' && (!init?.method || init.method === 'GET')) {
          // parked like a real fetch, so the first paint stays on its load
          return new Promise<Response>((resolve) => {
            release = resolve
          })
        }
        if (base === '/api/attention' || base === '/api/models/options') {
          return Promise.resolve(Response.json([]))
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${base}`)
      }),
    )
    renderHome()

    // an uncommitted roster claims nothing about the fleet
    expect(screen.getByText('Loading sessions…')).toBeInTheDocument()
    expect(screen.queryByText(/No live sessions/)).not.toBeInTheDocument()

    release(Response.json([]))
    expect(await screen.findByText(/No live sessions/)).toBeInTheDocument()
    expect(screen.queryByText('Loading sessions…')).not.toBeInTheDocument()
  })

  it('styles the launch command as code with no backticks', async () => {
    sessionsReply = []
    renderHome()

    const empty = await screen.findByText(/no live sessions/i)
    expect(empty.textContent).toBe('No live sessions. Launch one or start ajent --serve yourself.')
    expect(empty.querySelector('code')).toHaveTextContent('ajent --serve')
  })

  it('labels the workspace action with the selection size', async () => {
    sessionsReply = [session({ sessionId: '01A' }), session({ sessionId: '01B' })]
    renderHome()
    const user = userEvent.setup()
    await screen.findByText('01A')

    // no selection keeps the focused-mode open action
    expect(screen.getByRole('button', { name: 'Open workspace' })).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: 'Select 01A for tiling' }))
    await user.click(screen.getByRole('checkbox', { name: 'Select 01B for tiling' }))
    const tile = screen.getByRole('button', { name: 'Tile 2 selected' })

    // the labeled action still tiles the explicit selection
    await user.click(tile)
    expect(await screen.findByText('tiled 01A,01B')).toBeInTheDocument()
  })

  it('seeds the launch form with the most recent workspace', async () => {
    sessionsReply = [
      session({ sessionId: '01A', workspace: '/repo/alpha' }),
      session({ sessionId: '01B', workspace: '/repo/beta' }),
    ]
    renderHome()
    const user = userEvent.setup()
    await screen.findByText('alpha')

    await user.click(screen.getByRole('button', { name: 'Launch session' }))

    // the first known option preselects and hides the custom reveal
    expect(screen.getByLabelText('Working directory')).toHaveValue('/repo/alpha')
    expect(screen.queryByLabelText('Directory path')).not.toBeInTheDocument()

    // custom path stays an explicit choice
    await user.selectOptions(screen.getByLabelText('Working directory'), '')
    expect(screen.getByLabelText('Directory path')).toBeInTheDocument()
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

  it('badges chained sessions from the listing fields', async () => {
    sessionsReply = [
      session({ sessionId: '01A', chainedOn: '01B' }),
      session({ sessionId: '01B', deliveringTo: '01A' }),
      session({ sessionId: '01C' }),
    ]
    renderHome()

    // both roles of a live chain badge, unlinked sessions stay quiet
    const cards = (await screen.findAllByText(/pid|chained|swarm/, { selector: '.badge' })).filter(
      (el) => el.textContent === 'chained',
    )
    expect(cards).toHaveLength(2)
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
    await user.click(screen.getByRole('button', { name: 'Tile 2 selected' }))
    expect(await screen.findByText('tiled 01A,01A')).toBeInTheDocument()
  })

  it('narrows cards case-insensitively across every fact', async () => {
    sessionsReply = [
      session({ sessionId: '01AAA', title: 'Nightly Sweep' }),
      session({ sessionId: '01BBB', name: 'agent B' }),
      session({ sessionId: '01CCC', model: 'p/M1', workspace: '/home/you/Repo' }),
      session({ sessionId: '01DDD' }),
    ]
    renderHome()
    const user = userEvent.setup()
    await screen.findByText('Nightly Sweep')

    const box = screen.getByRole('searchbox', { name: 'Filter sessions' })
    const selected = () =>
      screen
        .getAllByRole('checkbox', { name: /Select .* for tiling/ })
        .map((box) => box.getAttribute('aria-label'))

    // display title
    await user.type(box, 'nightly')
    expect(selected()).toEqual(['Select Nightly Sweep for tiling'])
    await user.clear(box)

    // agent name
    await user.type(box, 'AGENT B')
    expect(selected()).toEqual(['Select agent B for tiling'])
    await user.clear(box)

    // session id, matched by lowercase fragment
    await user.type(box, '01ccc')
    expect(selected()).toEqual(['Select /home/you/Repo for tiling'])
    await user.clear(box)

    // model, then workspace tail
    await user.type(box, 'p/m1')
    expect(selected()).toEqual(['Select /home/you/Repo for tiling'])
    await user.clear(box)
    await user.type(box, 'repo')
    expect(selected()).toEqual(['Select /home/you/Repo for tiling'])
  })

  it('treats a whitespace-only query as no filter', async () => {
    sessionsReply = [session({ sessionId: '01A' }), session({ sessionId: '01B' })]
    renderHome()
    const user = userEvent.setup()
    await screen.findByText('01A')

    await user.type(screen.getByRole('searchbox', { name: 'Filter sessions' }), '   ')
    expect(screen.getByRole('checkbox', { name: 'Select 01A for tiling' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Select 01B for tiling' })).toBeInTheDocument()
    expect(screen.queryByText(/No sessions match/)).not.toBeInTheDocument()
  })

  it('names the query in the no-match state with a clear action', async () => {
    sessionsReply = [session({ sessionId: '01A', title: 'alpha' })]
    renderHome()
    const user = userEvent.setup()
    await screen.findByText('alpha')

    await user.type(screen.getByRole('searchbox', { name: 'Filter sessions' }), 'zzz')
    expect(screen.getByText('No sessions match “zzz”.')).toBeInTheDocument()
    expect(screen.queryByText(/No live sessions/)).not.toBeInTheDocument()

    // clearing restores the prior list
    await user.click(screen.getByRole('button', { name: 'Clear filter' }))
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.queryByText(/No sessions match/)).not.toBeInTheDocument()
  })

  it('keeps hidden selections and tiles them after clearing', async () => {
    sessionsReply = [
      session({ sessionId: '01AAA', title: 'alpha' }),
      session({ sessionId: '01BBB', title: 'beta' }),
    ]
    renderHome()
    const user = userEvent.setup()
    await screen.findByText('alpha')

    await user.click(screen.getByRole('checkbox', { name: 'Select alpha for tiling' }))
    await user.click(screen.getByRole('checkbox', { name: 'Select beta for tiling' }))
    // the action area counts the whole selection
    expect(screen.getByText('2 selected')).toBeInTheDocument()

    // filtering one card away must not silently drop its selection
    const box = screen.getByRole('searchbox', { name: 'Filter sessions' })
    await user.type(box, 'alpha')
    expect(
      screen.queryByRole('checkbox', { name: 'Select beta for tiling' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('2 selected')).toBeInTheDocument()

    // clearing the box restores the full roster, selection intact
    await user.clear(box)
    expect(screen.getByRole('checkbox', { name: 'Select beta for tiling' })).toBeChecked()

    // the tile request still carries the hidden instance
    await user.click(screen.getByRole('button', { name: 'Tile 2 selected' }))
    expect(await screen.findByText('tiled 01AAA,01BBB')).toBeInTheDocument()
  })

  it('prunes selection keys whose instance leaves the roster', async () => {
    sessionsReply = [session({ sessionId: '01A' })]
    renderHome()
    const user = userEvent.setup()
    await screen.findByText('01A')

    await user.click(screen.getByRole('checkbox', { name: 'Select 01A for tiling' }))
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    // a poll drops the instance entirely: the stale selection key goes with it
    sessionsReply = [session({ sessionId: '01B' })]
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(screen.getByText('01B')).toBeInTheDocument())
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear selection' })).not.toBeInTheDocument()
  })

  it('keeps card actions working while a filter is active', async () => {
    sessionsReply = [
      session({ sessionId: '01A', title: 'alpha' }),
      session({ sessionId: '01B', title: 'beta' }),
    ]
    renderHome()
    const user = userEvent.setup()
    await screen.findByText('alpha')

    await user.type(screen.getByRole('searchbox', { name: 'Filter sessions' }), 'alpha')
    // only the matching card's actions remain
    expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(1)

    // the surviving card's armed stop still fires end to end
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    await user.click(screen.getByRole('button', { name: 'Stop?' }))
    await vi.waitFor(() => expect(stopPosts()).toHaveLength(1))
  })
})

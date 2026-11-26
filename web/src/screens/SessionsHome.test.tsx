import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SessionsHome from './SessionsHome'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'
import { MockWebSocket } from '../test/mockWebSocket'
import { ChildState, type SessionStatus, type AttentionRow } from '../api/types'

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

function attentionRow(overrides: Partial<AttentionRow> & { sessionId: string }): AttentionRow {
  return {
    openInteractions: 0,
    running: false,
    idle: true,
    kind: 'awaiting',
    ...overrides,
  }
}

let sessionsReply: SessionStatus[]
let attentionReply: AttentionRow[]
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
    attentionReply = []
    fetchSpy = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const base = String(url)
        .replace(/^https?:\/\/[^/]+/, '')
        .split('?')[0]
      if (base === '/api/me')
        return Promise.resolve(Response.json({ username: 'you', via: 'cookie' }))
      if (base === '/api/sessions' && (!init?.method || init.method === 'GET')) {
        return Promise.resolve(Response.json(sessionsReply))
      }
      if (base === '/api/attention') {
        return Promise.resolve(Response.json(attentionReply))
      }
      if (base === '/api/sessions/01A/stop') {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      if (base === '/api/models/options' || base === '/api/tools/options') {
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

  it('titles the tab after the route', () => {
    renderHome()

    expect(document.title).toBe('Sessions · ajent-swarm')
  })

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
        if (
          base === '/api/attention' ||
          base === '/api/models/options' ||
          base === '/api/tools/options'
        ) {
          return Promise.resolve(Response.json([]))
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${base}`)
      }),
    )
    renderHome()

    // an uncommitted roster claims nothing about the fleet
    const loading = screen.getByText('Loading sessions…')
    expect(loading).toHaveAttribute('role', 'status')
    expect(loading).toHaveAttribute('aria-busy', 'true')
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

  it('focuses the filter on / outside an input', async () => {
    sessionsReply = [session()]
    renderHome()
    await screen.findByText('01A')

    fireEvent.keyDown(document.body, { key: '/' })

    expect(screen.getByRole('searchbox', { name: 'Filter sessions' })).toHaveFocus()
  })

  it('reports the visible count as the query narrows', async () => {
    sessionsReply = [
      session({ sessionId: '01A', title: 'alpha' }),
      session({ sessionId: '01B', title: 'beta' }),
      session({ sessionId: '01C', title: 'gamma' }),
    ]
    renderHome()
    const user = userEvent.setup()
    await screen.findByText('alpha')

    expect(screen.getByText('3 of 3 sessions')).toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: 'Filter sessions' }), 'alph')
    // the count trails the keystrokes through its announce debounce
    await screen.findByText('1 of 3 sessions')
    expect(screen.queryByText(/No sessions match/)).not.toBeInTheDocument()
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
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
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

  it('narrows the grid by the running state', async () => {
    sessionsReply = [
      // a spinner is busy through sessionBusy, the badges' derivation
      session({ sessionId: '01A', title: 'alpha', spinning: true, idle: false }),
      session({ sessionId: '01B', title: 'beta', running: true, idle: false }),
      session({
        sessionId: '01C',
        title: 'gamma',
        state: ChildState.Exited,
        detail: 'ended on its own',
      }),
    ]
    renderHome()
    const user = userEvent.setup()
    await screen.findByText('alpha')

    await user.selectOptions(screen.getByLabelText('Filter by state'), 'running')
    expect(screen.getByRole('checkbox', { name: 'Select alpha for tiling' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Select beta for tiling' })).toBeInTheDocument()
    expect(
      screen.queryByRole('checkbox', { name: 'Select gamma for tiling' }),
    ).not.toBeInTheDocument()
  })

  it('keeps open interactions under the needs-input state', async () => {
    sessionsReply = [
      // the digest kind leads even when the listing lags behind at zero
      session({ sessionId: '01A', title: 'digest' }),
      // no digest row yet, the listing's open interactions stand in
      session({ sessionId: '01B', title: 'fallback', openInteractions: 2 }),
      session({ sessionId: '01C', title: 'quiet' }),
      // a present kind wins over the listing count: one attention model
      session({ sessionId: '01D', title: 'overridden', openInteractions: 3 }),
    ]
    attentionReply = [
      attentionRow({ sessionId: '01A', kind: 'needs-input', openInteractions: 1, idle: false }),
      attentionRow({ sessionId: '01D', kind: 'working', running: true, idle: false }),
    ]
    renderHome()
    const user = userEvent.setup()
    await screen.findByText('digest')

    await user.selectOptions(screen.getByLabelText('Filter by state'), 'needs-input')
    expect(screen.getByRole('checkbox', { name: 'Select digest for tiling' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Select fallback for tiling' })).toBeInTheDocument()
    expect(
      screen.queryByRole('checkbox', { name: 'Select quiet for tiling' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('checkbox', { name: 'Select overridden for tiling' }),
    ).not.toBeInTheDocument()
  })

  it('keeps only ended sessions under the ended state', async () => {
    sessionsReply = [
      session({ sessionId: '01A', title: 'alpha' }),
      session({ sessionId: '01B', title: 'beta', running: true, idle: false }),
      session({
        sessionId: '01C',
        title: 'gamma',
        state: ChildState.Exited,
        detail: 'ended on its own',
      }),
    ]
    renderHome()
    const user = userEvent.setup()
    await screen.findByText('alpha')

    await user.selectOptions(screen.getByLabelText('Filter by state'), 'ended')
    expect(screen.getByRole('checkbox', { name: 'Select gamma for tiling' })).toBeInTheDocument()
    expect(
      screen.queryByRole('checkbox', { name: 'Select alpha for tiling' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('checkbox', { name: 'Select beta for tiling' }),
    ).not.toBeInTheDocument()

    // all reads as every row again
    await user.selectOptions(screen.getByLabelText('Filter by state'), 'all')
    expect(screen.getByRole('checkbox', { name: 'Select alpha for tiling' })).toBeInTheDocument()
  })

  it('sorts urgency first only when toggled on', async () => {
    sessionsReply = [
      session({ sessionId: '01A', title: 'worker', running: true, idle: false }),
      // the needs rows sit mid-roster, off must keep that order
      session({ sessionId: '01B', title: 'dialog' }),
      session({ sessionId: '01C', title: 'review' }),
      session({ sessionId: '01D', title: 'idler' }),
      session({ sessionId: '01E', title: 'departed', state: ChildState.Exited }),
    ]
    attentionReply = [
      attentionRow({ sessionId: '01A', kind: 'working', running: true, idle: false }),
      attentionRow({ sessionId: '01B', kind: 'needs-input', openInteractions: 1, idle: false }),
      attentionRow({ sessionId: '01C', kind: 'needs-review' }),
    ]
    renderHome()
    const user = userEvent.setup()
    await screen.findByText('worker')

    const order = () =>
      screen
        .getAllByRole('checkbox', { name: /Select .* for tiling/ })
        .map((box) => box.getAttribute('aria-label'))

    // default off: the roster order stands untouched
    expect(order()).toEqual([
      'Select worker for tiling',
      'Select dialog for tiling',
      'Select review for tiling',
      'Select idler for tiling',
      'Select departed for tiling',
    ])

    await user.click(screen.getByRole('checkbox', { name: 'Urgency first' }))
    // needs input, then review, then working; the rowless session ranks as
    // waiting and the ended one trails every live kind
    expect(order()).toEqual([
      'Select dialog for tiling',
      'Select review for tiling',
      'Select worker for tiling',
      'Select idler for tiling',
      'Select departed for tiling',
    ])
  })

  it('adds only visible keys from Select all visible', async () => {
    sessionsReply = [
      session({ sessionId: '01A', title: 'alpha' }),
      session({ sessionId: '01B', title: 'beta' }),
      session({ sessionId: '01C', title: 'zebra', running: true, idle: false }),
    ]
    renderHome()
    const user = userEvent.setup()
    await screen.findByText('alpha')

    // the row a filter will hide is selected first, its key must survive
    await user.click(screen.getByRole('checkbox', { name: 'Select zebra for tiling' }))
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: 'Filter sessions' }), 'alp')
    expect(
      screen.queryByRole('checkbox', { name: 'Select beta for tiling' }),
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Select all visible' }))
    // alpha joined, zebra's hidden selection untouched
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    // every visible row carries its key now, the action stands down
    expect(screen.queryByRole('button', { name: 'Select all visible' })).not.toBeInTheDocument()

    // clearing the query restores the roster with exactly those keys held
    await user.clear(screen.getByRole('searchbox', { name: 'Filter sessions' }))
    expect(screen.getByRole('checkbox', { name: 'Select alpha for tiling' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Select beta for tiling' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Select zebra for tiling' })).toBeChecked()

    // the tile request carries every selected instance, hidden ones included
    await user.click(screen.getByRole('button', { name: 'Tile 2 selected' }))
    expect(await screen.findByText('tiled 01C,01A')).toBeInTheDocument()
  })

  it('resets the query and state filter together', async () => {
    sessionsReply = [
      session({ sessionId: '01A', title: 'alpha' }),
      session({ sessionId: '01B', title: 'beta', running: true, idle: false }),
    ]
    renderHome()
    const user = userEvent.setup()
    await screen.findByText('alpha')

    // both knobs active so only the combined reset recovers the rows
    await user.selectOptions(screen.getByLabelText('Filter by state'), 'ended')
    await user.type(screen.getByRole('searchbox', { name: 'Filter sessions' }), 'alpha')
    expect(screen.getByText('No sessions match “alpha”.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.getByLabelText('Filter by state')).toHaveValue('all')
    expect(screen.getByRole('searchbox', { name: 'Filter sessions' })).toHaveValue('')
    expect(screen.getByRole('checkbox', { name: 'Select alpha for tiling' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Select beta for tiling' })).toBeInTheDocument()
  })

  it('names the state filter in the no-match copy', async () => {
    sessionsReply = [session({ sessionId: '01A', title: 'alpha' })]
    renderHome()
    const user = userEvent.setup()
    await screen.findByText('alpha')

    // only the state filter empties the grid, so its name leads
    await user.selectOptions(screen.getByLabelText('Filter by state'), 'ended')
    expect(screen.getByText('No ended sessions.')).toBeInTheDocument()

    // a query names itself, whichever state sits beside it
    await user.type(screen.getByRole('searchbox', { name: 'Filter sessions' }), 'zzz')
    expect(screen.getByText('No sessions match “zzz”.')).toBeInTheDocument()
    expect(screen.queryByText('No ended sessions.')).not.toBeInTheDocument()
  })
})

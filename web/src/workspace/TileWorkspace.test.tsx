import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import TileWorkspace from './TileWorkspace'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'
import { MockWebSocket } from '../test/mockWebSocket'
import type { AttentionRow } from '../api/types'

// The tile surface renders the persisted tree as panes with tab strips,
// badges backgrounded sessions whose attention rises, closes tabs through the
// strip, and navigates to Sessions once the last pane closes. An empty tile
// screen remains only when nothing live could be tiled at all.
const LEFT = '01LEFTSESSION00001'
const RIGHT = '01RIGHTSESSION0001'

const tree = {
  kind: 'split',
  id: 'row1',
  dir: 'row',
  ratio: 0.5,
  a: { kind: 'pane', id: 'p1', tabs: [LEFT], active: LEFT },
  b: { kind: 'pane', id: 'p2', tabs: [RIGHT], active: RIGHT },
}

// One pane holding both sessions with the second active: a strip with a
// background tab to click, walk onto or close.
const stackedTree = {
  kind: 'pane',
  id: 'p1',
  tabs: [LEFT, RIGHT],
  active: RIGHT,
}

// TileAgain mimics the shell's Tile switcher: tiling is a verb carried by a
// fresh navigation to an explicit open list, identical here across two clicks.
function TileAgain({ open }: { open: string }) {
  const navigate = useNavigate()
  return (
    <button type="button" data-testid="tile-again" onClick={() => navigate(`/tile?open=${open}`)}>
      tile again
    </button>
  )
}

// SearchProbe records the router's query string so tests can assert deep-link
// cleanup; MemoryRouter never touches window.location.
let currentSearch = ''

function SearchProbe() {
  const { search } = useLocation()
  useEffect(() => {
    currentSearch = search
  }, [search])
  return null
}

function attentionRows(): AttentionRow[] {
  return [
    {
      sessionId: RIGHT,
      pid: 2,
      openInteractions: 1,
      running: false,
      idle: false,
      dialogId: 3,
      dialogPrompt: 'allow write?',
      dialogAt: Date.now() - 5_000,
      kind: 'needs-input',
      reason: 'allow write?',
      since: Date.now() - 5_000,
    },
    {
      sessionId: LEFT,
      pid: 1,
      openInteractions: 0,
      running: false,
      idle: true,
      kind: 'awaiting',
      reason: 'waiting for a prompt',
    },
  ]
}

// pendingDialog is one text-answer interaction, paneAnswer finds the card's
// input inside a pane's dock.
function pendingDialog(id: number, prompt: string) {
  return { id, kind: 'input', prompt, text: true }
}

function paneAnswer(paneId: string): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(`[data-pane-id="${paneId}"] .dialog-card input`)
}

// domPaneIds reads the mounted panes in document order. tileFor mints fresh
// node ids on every run, so a re-tile always lands a different list.
function domPaneIds(): (string | null)[] {
  return [...document.querySelectorAll('[data-pane-id]')].map((el) =>
    el.getAttribute('data-pane-id'),
  )
}

// storedRatio reads the persisted ratio a divider drag commits.
function storedRatio(): number {
  const stored = JSON.parse(localStorage.getItem('swarm.workspace.v1') ?? '{}')
  return stored.tile.tree.ratio
}

describe('TileWorkspace', () => {
  let sockets: MockWebSocket[]
  let attention: AttentionRow[]

  beforeEach(() => {
    localStorage.clear()
    currentSearch = ''
    attention = attentionRows()
    localStorage.setItem(
      'swarm.workspace.v1',
      JSON.stringify({ mode: 'tile', focused: {}, tile: { tree, focusedPaneId: 'p1' } }),
    )
    // jsdom ships no pointer capture, divider drags only need the events
    Element.prototype.setPointerCapture = () => {}
    vi.stubGlobal(
      'WebSocket',
      class extends MockWebSocket {
        constructor(url: string) {
          super(url)
          sockets.push(this)
        }
      },
    )
    sockets = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const path = String(url)
          .replace(/^https?:\/\/[^/]+/, '')
          .split('?')[0]
        if (path === '/api/me') {
          return Promise.resolve(Response.json({ username: 'you', via: 'cookie' }))
        }
        if (path === '/api/sessions') {
          return Promise.resolve(
            Response.json([
              { sessionId: LEFT, name: 'left', state: 'online', spawnedBy: 'external' },
              { sessionId: RIGHT, name: 'right', state: 'online', spawnedBy: 'external' },
            ]),
          )
        }
        if (path === '/api/attention') return Promise.resolve(Response.json(attention))
        const snap = /\/api\/sessions\/([^/]+)\/snapshot/.exec(path)
        if (snap) return Promise.resolve(Response.json({ session: { id: snap[1] } }))
        if (path.endsWith('/candidates')) {
          return Promise.resolve(Response.json({ head: '', candidates: [] }))
        }
        return Promise.resolve(Response.json({}))
      }),
    )
  })

  afterEach(() => {
    sockets = []
    Reflect.deleteProperty(Element.prototype, 'setPointerCapture')
    vi.unstubAllGlobals()
  })

  function renderTile(initial = '/tile', retileOpen?: string) {
    return render(
      <MemoryRouter initialEntries={[initial]}>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              {retileOpen !== undefined && <TileAgain open={retileOpen} />}
              <SearchProbe />
              <Routes>
                <Route path="/tile" element={<TileWorkspace />} />
                {/* last-pane close lands here instead of an empty tile screen */}
                <Route
                  path="/sessions"
                  element={<div data-testid="sessions-screen">Sessions</div>}
                />
              </Routes>
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
  }

  // pinnedDivider mounts the persisted split with its divider, pinning the
  // split's box (jsdom has no layout) so a drag's clientX maps to a clean
  // ratio: x within 0..1000.
  async function pinnedDivider(): Promise<HTMLElement> {
    renderTile()
    await screen.findAllByText('right') // the persisted split rendered its divider
    const split = document.querySelector('.tile-split')
    const divider = document.querySelector('.tile-divider')
    if (!(split instanceof HTMLElement) || !(divider instanceof HTMLElement)) {
      throw new Error('no tile split mounted')
    }
    vi.spyOn(split, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 600))
    return divider
  }

  // renderStacked mounts the stacked tree and waits for its pane to land.
  async function renderStacked(): Promise<void> {
    localStorage.setItem(
      'swarm.workspace.v1',
      JSON.stringify({
        mode: 'tile',
        focused: {},
        tile: { tree: stackedTree, focusedPaneId: 'p1' },
      }),
    )
    renderTile()
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0))
    act(() => sockets[0].open())
    await screen.findAllByText('right')
  }

  it('renders the persisted tree as panes and hosts each active tab', async () => {
    renderTile()
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0))
    act(() => sockets[0].open())

    await waitFor(() => {
      const opens = sockets[0].sent.map((raw) => JSON.parse(raw))
      expect(opens).toContainEqual({ type: 'subscribe', sessionId: LEFT })
      expect(opens).toContainEqual({ type: 'subscribe', sessionId: RIGHT })
    })

    // two panes, one each, the tree survived the round trip through storage
    expect(document.querySelectorAll('[data-pane-id]')).toHaveLength(2)
    expect(document.querySelector('[data-pane-id="p1"]')?.className).toContain('focused')

    // the backgrounded session with a dialog badges, the focused one does not
    const badges = document.querySelectorAll('.tab-badge.needs-input')
    expect(badges).toHaveLength(1)
    expect(badges[0].getAttribute('aria-label')).toBe('needs input')
  })

  it('gives dialog autofocus to the focused pane only', async () => {
    renderTile()
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0))
    act(() => sockets[0].open())
    await waitFor(() => {
      const opens = sockets[0].sent.map((raw) => JSON.parse(raw))
      expect(opens).toContainEqual({ type: 'subscribe', sessionId: LEFT })
      expect(opens).toContainEqual({ type: 'subscribe', sessionId: RIGHT })
    })

    // a text answer rises in the backgrounded pane first
    act(() => {
      sockets[0].message({
        type: 'event',
        sessionId: RIGHT,
        event: { event: 'interaction.pending', seq: 1, data: pendingDialog(3, 'background key?') },
      })
    })
    expect(await screen.findByText('background key?')).toBeInTheDocument()

    // cross-pane theft is the bug the focus policy exists for, attention
    // surfaces it instead (the badge case above covers that claim)
    const background = paneAnswer('p2')
    expect(background).not.toBeNull()
    expect(document.activeElement).not.toBe(background)

    // the focused pane's own dialog takes the caret on mount
    act(() => {
      sockets[0].message({
        type: 'event',
        sessionId: LEFT,
        event: { event: 'interaction.pending', seq: 1, data: pendingDialog(4, 'focused key?') },
      })
    })
    expect(await screen.findByText('focused key?')).toBeInTheDocument()
    expect(document.activeElement).toBe(paneAnswer('p1'))
  })

  it('closes a tab through the strip and keeps the sibling pane', async () => {
    renderTile()
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0))
    act(() => sockets[0].open())
    // the tab strips render alongside each pane's add-session picker menu
    await screen.findAllByText('right')

    const user = userEvent.setup()
    await user.click(screen.getByLabelText('Close right'))

    // the pane emptied away, the left pane remains as the whole tree
    await waitFor(() => expect(document.querySelectorAll('[data-pane-id]')).toHaveLength(1))
    expect(document.querySelector('[data-pane-id="p1"]')).not.toBeNull()
    const stored = JSON.parse(localStorage.getItem('swarm.workspace.v1') ?? '{}')
    expect(stored.tile.tree.kind).toBe('pane') // the split rebalanced away
  })

  it('auto-tiles reachable sessions when no panes are open', async () => {
    localStorage.setItem(
      'swarm.workspace.v1',
      JSON.stringify({ mode: 'tile', focused: {}, tile: { tree: null } }),
    )
    renderTile()

    // both live sessions split into their own panes without any clicks
    await waitFor(() => expect(document.querySelectorAll('[data-pane-id]')).toHaveLength(2))
    const stored = JSON.parse(localStorage.getItem('swarm.workspace.v1') ?? '{}')
    expect(stored.tile.tree.kind).toBe('split')
  })

  it('retiles exactly the requested open list over a persisted tree', async () => {
    // a stale single-pane arrangement must not swallow the explicit request
    localStorage.setItem(
      'swarm.workspace.v1',
      JSON.stringify({
        mode: 'tile',
        focused: {},
        tile: { tree: { kind: 'pane', id: 'p1', tabs: [LEFT], active: LEFT } },
      }),
    )
    renderTile('/tile?open=' + LEFT + ',' + RIGHT)

    await waitFor(() => expect(document.querySelectorAll('[data-pane-id]')).toHaveLength(2))
    const stored = JSON.parse(localStorage.getItem('swarm.workspace.v1') ?? '{}')
    expect(stored.tile.tree.kind).toBe('split')
  })

  it('tiles three requested sessions into three panes', async () => {
    const THIRD = '01THIRDSESSION000001'
    localStorage.setItem(
      'swarm.workspace.v1',
      JSON.stringify({ mode: 'tile', focused: {}, tile: { tree: null } }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const path = String(url)
          .replace(/^https?:\/\/[^/]+/, '')
          .split('?')[0]
        if (path === '/api/me') {
          return Promise.resolve(Response.json({ username: 'you', via: 'cookie' }))
        }
        if (path === '/api/sessions') {
          return Promise.resolve(
            Response.json([
              { sessionId: LEFT, name: 'left', state: 'online', spawnedBy: 'external' },
              { sessionId: RIGHT, name: 'right', state: 'online', spawnedBy: 'external' },
              { sessionId: THIRD, name: 'third', state: 'online', spawnedBy: 'external' },
            ]),
          )
        }
        if (path === '/api/attention') return Promise.resolve(Response.json([]))
        const snap = /\/api\/sessions\/([^/]+)\/snapshot/.exec(path)
        if (snap) return Promise.resolve(Response.json({ session: { id: snap[1] } }))
        return Promise.resolve(Response.json({}))
      }),
    )
    renderTile('/tile?open=' + [LEFT, RIGHT, THIRD].join(','))

    await waitFor(() => expect(document.querySelectorAll('[data-pane-id]')).toHaveLength(3))
  })

  it('tiles a repeated open entry as twin panes', async () => {
    // resuming an already running session lists one id twice: the selection
    // carries that duplication, so both instances land in their own pane
    renderTile('/tile?open=' + LEFT + ',' + LEFT)

    await waitFor(() => expect(document.querySelectorAll('[data-pane-id]')).toHaveLength(2))
    const names = [...document.querySelectorAll('.tab-name')].map((el) => el.textContent)
    expect(names).toEqual(['left', 'left'])
  })

  it('retiles on a repeated identical open request', async () => {
    localStorage.setItem(
      'swarm.workspace.v1',
      JSON.stringify({ mode: 'tile', focused: {}, tile: { tree: null } }),
    )
    renderTile('/tile?open=' + LEFT + ',' + RIGHT, LEFT + ',' + RIGHT)

    await waitFor(() => expect(domPaneIds()).toHaveLength(2))
    const first = domPaneIds()

    // the same live set navigates again: every pane is rebuilt, not swallowed
    const user = userEvent.setup()
    await user.click(screen.getByTestId('tile-again'))
    await waitFor(() => expect(domPaneIds()).not.toEqual(first))
    expect(domPaneIds()).toHaveLength(2)
  })

  it('drops a fully stale open list', async () => {
    localStorage.setItem(
      'swarm.workspace.v1',
      JSON.stringify({ mode: 'tile', focused: {}, tile: { tree: null } }),
    )
    renderTile('/tile?open=01STALESESSION000001')

    // once the roster loads and nothing resolves, the request gives up: the
    // URL cleans up and the normal empty state auto-tiles what is live now
    await waitFor(() => expect(document.querySelectorAll('[data-pane-id]')).toHaveLength(2))
    const stored = JSON.parse(localStorage.getItem('swarm.workspace.v1') ?? '{}')
    expect(stored.tile.tree.kind).toBe('split')
    expect(currentSearch).toBe('')
  })

  it('stale open list with nothing live', async () => {
    localStorage.setItem(
      'swarm.workspace.v1',
      JSON.stringify({ mode: 'tile', focused: {}, tile: { tree: null } }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const path = String(url)
          .replace(/^https?:\/\/[^/]+/, '')
          .split('?')[0]
        if (path === '/api/me') {
          return Promise.resolve(Response.json({ username: 'you', via: 'cookie' }))
        }
        if (path === '/api/sessions' || path === '/api/attention') {
          return Promise.resolve(Response.json([]))
        }
        return Promise.resolve(Response.json({}))
      }),
    )
    renderTile('/tile?open=01STALESESSION000001')

    // the screen at rest matches a plain empty visit, only the URL differs
    expect(await screen.findByText('No panes open.')).toBeInTheDocument()
    expect(screen.getByText('No live sessions to open.')).toBeInTheDocument()
    await waitFor(() => expect(currentSearch).toBe(''))
  })

  it('applies partial stale open lists', async () => {
    localStorage.setItem(
      'swarm.workspace.v1',
      JSON.stringify({ mode: 'tile', focused: {}, tile: { tree: null } }),
    )
    renderTile('/tile?open=' + LEFT + ',01STALESESSION000001')

    // the request applies exactly what resolved, never waiting on the rest
    await waitFor(() => expect(document.querySelectorAll('[data-pane-id]')).toHaveLength(1))
    const names = [...document.querySelectorAll('.tab-name')].map((el) => el.textContent)
    expect(names).toEqual(['left'])
  })

  it('leaves tile mode for sessions when the last pane closes', async () => {
    localStorage.setItem(
      'swarm.workspace.v1',
      JSON.stringify({ mode: 'tile', focused: {}, tile: { tree }, focusedPaneId: 'p1' }),
    )
    renderTile()
    await screen.findAllByText('right')

    // closing the last tab empties the tree, auto-tiling must not re-seed it
    const user = userEvent.setup()
    await user.click(screen.getByLabelText('Close right'))
    await waitFor(() => expect(document.querySelectorAll('[data-pane-id]')).toHaveLength(1))

    // the final close hands off to Sessions instead of the empty state
    await user.click(screen.getByLabelText('Close left'))
    expect(await screen.findByTestId('sessions-screen')).toBeInTheDocument()
    expect(screen.queryByText('No panes open.')).not.toBeInTheDocument()

    // the emptied arrangement is what persists for a later plain visit
    const stored = JSON.parse(localStorage.getItem('swarm.workspace.v1') ?? '{}')
    expect(stored.tile.tree).toBeNull()
  })

  it('opens the + picker into a body-level menu past pane clipping', async () => {
    renderTile()
    // the tab strips render alongside each pane's add-session picker trigger
    await screen.findAllByText('right')

    const user = userEvent.setup()
    await user.click(screen.getAllByLabelText('Add a session to this pane')[0])

    // jsdom has no layout, so placement is the claim under test: the menu
    // portals out of .tile-pane, where overflow:hidden used to cut it off
    const menus = document.querySelectorAll('.tile-menu')
    expect(menus).toHaveLength(1)
    const menu = menus[0]
    expect(menu.parentElement).toBe(document.body)
    expect(within(menu as HTMLElement).getByRole('menuitem', { name: 'left' })).toBeInTheDocument()
  })

  it('presents an activated tab fresh instead of reusing the last view', async () => {
    await renderStacked()

    // transient chrome opens over the active session
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Rewind' }))
    expect(
      await screen.findByRole('dialog', { name: 'Rewind to an earlier point' }),
    ).toBeInTheDocument()

    // closing it activates the neighbor tab: a fresh view, no leftover dialog,
    // and the newly shown session subscribes
    await user.click(screen.getByLabelText('Close right'))
    expect(
      screen.queryByRole('dialog', { name: 'Rewind to an earlier point' }),
    ).not.toBeInTheDocument()
    await waitFor(() => {
      const opens = sockets[0].sent.map((raw) => JSON.parse(raw))
      expect(opens).toContainEqual({ type: 'subscribe', sessionId: LEFT })
    })
  })

  it('activates a background tab when clicked', async () => {
    await renderStacked()

    const activeName = () => document.querySelector('.tile-tab.active .tab-name')?.textContent
    expect(activeName()).toBe('right')

    const user = userEvent.setup()
    await user.click(screen.getByText('left', { selector: '.tab-name' }))

    // the pane swapped to the clicked session, which mounts its own view
    expect(activeName()).toBe('left')
    await waitFor(() => {
      const opens = sockets[0].sent.map((raw) => JSON.parse(raw))
      expect(opens).toContainEqual({ type: 'subscribe', sessionId: LEFT })
    })

    // the swap persists with focus kept on the pane
    const stored = JSON.parse(localStorage.getItem('swarm.workspace.v1') ?? '{}')
    expect(stored.tile.tree.active).toBe(LEFT)
    expect(stored.tile.focusedPaneId).toBe('p1')
  })

  it('renders the strip as a tablist with a roving tab stop', async () => {
    await renderStacked()

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual(['-1', '0'])
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true'])

    // each tab selects the pane's one panel, labeled by the active tab
    const panel = screen.getByRole('tabpanel')
    expect(tabs.map((tab) => tab.getAttribute('aria-controls'))).toEqual([panel.id, panel.id])
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[1].id)
    expect(screen.getByRole('tablist')).toBeInTheDocument()
  })

  it('activates a focused tab with Enter and Space', async () => {
    await renderStacked()

    const activeName = () => document.querySelector('.tile-tab.active .tab-name')?.textContent
    const user = userEvent.setup()
    screen.getByRole('tab', { name: /left/ }).focus() // a background tab
    await user.keyboard('{Enter}')

    // the pane swapped to the keyboard-activated session, which subscribes
    expect(activeName()).toBe('left')
    await waitFor(() => {
      const opens = sockets[0].sent.map((raw) => JSON.parse(raw))
      expect(opens).toContainEqual({ type: 'subscribe', sessionId: LEFT })
    })

    // Space activates back, like a native control
    screen.getByRole('tab', { name: /right/ }).focus()
    await user.keyboard(' ')
    expect(activeName()).toBe('right')

    // the keyboard swap persists with focus kept on the pane, like a click
    const stored = JSON.parse(localStorage.getItem('swarm.workspace.v1') ?? '{}')
    expect(stored.tile.tree.active).toBe(RIGHT)
    expect(stored.tile.focusedPaneId).toBe('p1')
  })

  it('walks tabs with arrows and Home or End without selecting', async () => {
    await renderStacked()

    const tabs = screen.getAllByRole('tab')
    const user = userEvent.setup()
    tabs[1].focus() // the active tab holds the strip's tab stop
    await user.keyboard('{ArrowLeft}')
    expect(document.activeElement).toBe(tabs[0])
    await user.keyboard('{ArrowLeft}') // wraps around the strip's end
    expect(document.activeElement).toBe(tabs[1])
    await user.keyboard('{Home}')
    expect(document.activeElement).toBe(tabs[0])
    await user.keyboard('{End}')
    expect(document.activeElement).toBe(tabs[1])

    // walking only moves focus: activation stays a deliberate key or click
    expect(document.querySelector('.tile-tab.active .tab-name')?.textContent).toBe('right')
  })

  it('leaves workspace arrow chords alone', async () => {
    await renderStacked()

    // Mod and Alt arrows move pane focus and resize splits: focus resting on
    // a tab must not turn them into tab walking
    const tabs = screen.getAllByRole('tab')
    const user = userEvent.setup()
    tabs[1].focus()
    await user.keyboard('{Meta>}{ArrowRight}{/Meta}')
    expect(document.activeElement).toBe(tabs[1])
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}')
    expect(document.activeElement).toBe(tabs[1])
  })

  it('keeps the strip close button native on Enter', async () => {
    await renderStacked()

    // Enter on the strip's inner control closes it: the tab's own binding
    // never intercepts a control inside it
    const user = userEvent.setup()
    screen.getByLabelText('Close right').focus()
    await user.keyboard('{Enter}')

    await waitFor(() => expect(document.querySelectorAll('.tile-tab')).toHaveLength(1))
    expect(document.querySelector('.tile-tab.active .tab-name')?.textContent).toBe('left')
  })

  it('announces badge kinds in human words', async () => {
    attention = [
      {
        sessionId: RIGHT,
        pid: 2,
        openInteractions: 0,
        running: false,
        idle: true,
        lastTurnEnd: Date.now() - 60_000,
        lastStop: 'end_turn',
        kind: 'needs-review',
        reason: 'turn complete',
        since: Date.now() - 60_000,
      },
      attentionRows()[1], // LEFT stays neutral
    ]
    renderTile()
    await screen.findAllByText('right')

    // the class carries the kind for color, the label carries the words, the
    // backgrounded pane badges while the focused one stays clean
    const badges = document.querySelectorAll('.tab-badge.needs-review')
    expect(badges).toHaveLength(1)
    expect(badges[0].getAttribute('aria-label')).toBe('needs review')
  })

  it('shows the empty state when no sessions are live', async () => {
    localStorage.setItem(
      'swarm.workspace.v1',
      JSON.stringify({ mode: 'tile', focused: {}, tile: { tree: null } }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const path = String(url)
          .replace(/^https?:\/\/[^/]+/, '')
          .split('?')[0]
        if (path === '/api/me') {
          return Promise.resolve(Response.json({ username: 'you', via: 'cookie' }))
        }
        if (path === '/api/sessions' || path === '/api/attention') {
          return Promise.resolve(Response.json([]))
        }
        return Promise.resolve(Response.json({}))
      }),
    )
    renderTile()

    expect(await screen.findByText('No panes open.')).toBeInTheDocument()
    expect(screen.getByText('No live sessions to open.')).toBeInTheDocument()
  })

  it('resizes the split through a divider drag', async () => {
    const divider = await pinnedDivider()

    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500, clientY: 300 })
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 800, clientY: 300 })
    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 800, clientY: 300 })

    expect(storedRatio()).toBeCloseTo(0.8)
  })

  it('stops resizing when the drag is cancelled mid-gesture', async () => {
    const divider = await pinnedDivider()

    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500, clientY: 300 })
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 800, clientY: 300 })
    // the system takes the pointer back: the drag ends where it last applied
    fireEvent.pointerCancel(divider, { pointerId: 1 })
    expect(storedRatio()).toBeCloseTo(0.8)

    // movement with no drag live must not keep resizing the split
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 100, clientY: 300 })
    expect(storedRatio()).toBeCloseTo(0.8)
  })

  it('ends the drag when the divider loses pointer capture', async () => {
    const divider = await pinnedDivider()

    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500, clientY: 300 })
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 800, clientY: 300 })
    // capture stolen or dropped mid-gesture is an ending like any other
    fireEvent(divider, new PointerEvent('lostpointercapture', { pointerId: 1, bubbles: true }))
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 100, clientY: 300 })

    expect(storedRatio()).toBeCloseTo(0.8)
  })

  it('ignores another pointer while a divider drag is live', async () => {
    const divider = await pinnedDivider()

    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500, clientY: 300 })
    // a second finger wandering over the divider must not move the split
    fireEvent.pointerMove(divider, { pointerId: 2, clientX: 100, clientY: 300 })
    expect(storedRatio()).toBeCloseTo(0.5)

    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 800, clientY: 300 })
    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 800, clientY: 300 })
    expect(storedRatio()).toBeCloseTo(0.8)
  })
})

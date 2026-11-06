import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import TileWorkspace from './TileWorkspace'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'
import { MockWebSocket } from '../test/mockWebSocket'
import { resetLedger } from './attention'
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

// One pane holding both sessions with the second active: closing that tab
// activates its neighbor, which is how a tab swap runs without dragging.
const stackedTree = {
  kind: 'pane',
  id: 'p1',
  tabs: [LEFT, RIGHT],
  active: RIGHT,
}

function attention(): AttentionRow[] {
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
    },
    { sessionId: LEFT, pid: 1, openInteractions: 0, running: false, idle: true },
  ]
}

// pendingDialog is one text-answer interaction; paneAnswer finds the card's
// input inside a pane's dock.
function pendingDialog(id: number, prompt: string) {
  return { id, kind: 'input', prompt, text: true }
}

function paneAnswer(paneId: string): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(`[data-pane-id="${paneId}"] .dialog-card input`)
}

describe('TileWorkspace', () => {
  let sockets: MockWebSocket[]

  beforeEach(() => {
    localStorage.clear()
    resetLedger()
    localStorage.setItem(
      'swarm.workspace.v1',
      JSON.stringify({ mode: 'tile', focused: {}, tile: { tree, focusedPaneId: 'p1' } }),
    )
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
        if (path === '/api/attention') return Promise.resolve(Response.json(attention()))
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
    vi.unstubAllGlobals()
  })

  function renderTile(initial = '/tile') {
    return render(
      <MemoryRouter initialEntries={[initial]}>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
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

  it('renders the persisted tree as panes and hosts each active tab', async () => {
    renderTile()
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0))
    act(() => sockets[0].open())

    await waitFor(() => {
      const opens = sockets[0].sent.map((raw) => JSON.parse(raw))
      expect(opens).toContainEqual({ type: 'subscribe', sessionId: LEFT })
      expect(opens).toContainEqual({ type: 'subscribe', sessionId: RIGHT })
    })

    // two panes, one each; the tree survived the round trip through storage
    expect(document.querySelectorAll('[data-pane-id]')).toHaveLength(2)
    expect(document.querySelector('[data-pane-id="p1"]')?.className).toContain('focused')

    // the backgrounded session with a dialog badges; the focused one does not
    const badges = document.querySelectorAll('.tab-badge.needs-input')
    expect(badges).toHaveLength(1)
    expect(badges[0].getAttribute('aria-label')).toBe('needs-input')
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

    // cross-pane theft is the bug the focus policy exists for; attention
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

    // the pane emptied away; the left pane remains as the whole tree
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

  it('leaves tile mode for sessions when the last pane closes', async () => {
    localStorage.setItem(
      'swarm.workspace.v1',
      JSON.stringify({ mode: 'tile', focused: {}, tile: { tree }, focusedPaneId: 'p1' }),
    )
    renderTile()
    await screen.findAllByText('right')

    // closing the last tab empties the tree; auto-tiling must not re-seed it
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
    await screen.findAllByText('right') // the persisted tree landed

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
})

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
// strip, and offers the picker on an empty tree.
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

describe('TileWorkspace', () => {
  let sockets: MockWebSocket[]

  beforeEach(() => {
    localStorage.clear()
    resetLedger()
    localStorage.setItem(
      'swarm.workspace.v1',
      JSON.stringify({ mode: 'tile', inbox: {}, tile: { tree, focusedPaneId: 'p1' } }),
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
        return Promise.resolve(Response.json({}))
      }),
    )
  })

  afterEach(() => {
    sockets = []
    vi.unstubAllGlobals()
  })

  function renderTile() {
    return render(
      <MemoryRouter initialEntries={['/tile']}>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <Routes>
                <Route path="/tile" element={<TileWorkspace />} />
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

  it('closes a tab through the strip and keeps the sibling pane', async () => {
    renderTile()
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0))
    act(() => sockets[0].open())
    await screen.findByText('right') // tab strips rendered

    const user = userEvent.setup()
    await user.click(screen.getByLabelText('Close right'))

    // the pane emptied away; the left pane remains as the whole tree
    await waitFor(() => expect(document.querySelectorAll('[data-pane-id]')).toHaveLength(1))
    expect(document.querySelector('[data-pane-id="p1"]')).not.toBeNull()
    const stored = JSON.parse(localStorage.getItem('swarm.workspace.v1') ?? '{}')
    expect(stored.tile.tree.kind).toBe('pane') // the split rebalanced away
  })

  it('offers the session picker when no panes are open', async () => {
    localStorage.setItem(
      'swarm.workspace.v1',
      JSON.stringify({ mode: 'tile', inbox: {}, tile: { tree: null } }),
    )
    renderTile()

    const picker = await screen.findByText('No panes open.')
    expect(picker).toBeInTheDocument()
    const chips = within(document.querySelector('.tile-empty') as HTMLElement).getAllByRole(
      'button',
    )
    expect(chips.map((c) => c.textContent)).toEqual(['left', 'right'])

    await userEvent.setup().click(chips[0])
    await waitFor(() => expect(document.querySelectorAll('[data-pane-id]')).toHaveLength(1))
    const stored = JSON.parse(localStorage.getItem('swarm.workspace.v1') ?? '{}')
    expect(stored.tile.tree.tabs).toEqual([LEFT])
  })
})

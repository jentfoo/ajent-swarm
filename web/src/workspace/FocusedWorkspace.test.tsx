import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import FocusedWorkspace from './FocusedWorkspace'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'
import { MockWebSocket } from '../test/mockWebSocket'
import { resetLedger } from './attention'
import type { AttentionRow } from '../api/types'

// The rail renders over the real provider stack with fetch and WebSocket
// mocks: mixed attention rows fill every section, acting on a row clears it,
// and the keyboard drives the queue.
const DIALOG = '01AAAAAAAAAAAAAA'
const REVIEW = '01BBBBBBBBBBBBBB'
const WORKER = '01CCCCCCCCCCCCCC'

function attentionRows(): AttentionRow[] {
  return [
    {
      sessionId: REVIEW,
      pid: 2,
      openInteractions: 0,
      running: false,
      idle: true,
      lastTurnEnd: Date.now() - 60_000,
      lastStop: 'end_turn',
    },
    {
      sessionId: DIALOG,
      pid: 1,
      openInteractions: 1,
      running: false,
      idle: false,
      dialogId: 7,
      dialogPrompt: 'allow write access?',
      dialogAt: Date.now() - 30_000,
    },
    {
      sessionId: WORKER,
      pid: 3,
      openInteractions: 0,
      running: true,
      idle: false,
      activity: 'reading main.go',
    },
  ]
}

function waitingRow(): AttentionRow {
  return {
    sessionId: '01WAITING00000000',
    pid: 4,
    openInteractions: 0,
    running: false,
    idle: true,
  }
}

function sessionsList() {
  return [
    { sessionId: DIALOG, name: 'dialog session', state: 'online', spawnedBy: 'external' },
    { sessionId: REVIEW, name: 'review session', state: 'online', spawnedBy: 'external' },
    { sessionId: WORKER, name: 'worker session', state: 'online', spawnedBy: 'external' },
  ]
}

function snapshotFor(sessionId: string) {
  const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  return {
    session: { id: sessionId },
    workspace: '',
    cwd: '',
    head: '',
    model: {
      key: '',
      short: '',
      window: 0,
      caps: { reasoning: false, images: false, parallelToolCalls: false },
    },
    permission: '',
    usage: { turns: 0, total: zeroUsage, child: zeroUsage, estimatedTurns: 0 },
    context: { used: 0, window: 0, reserve: 0, compact: 0, estimated: false },
    running: false,
    idle: true,
    spinning: false,
    queued: 0,
    queuedRows: [],
    seat: { held: false, yours: false },
  }
}

describe('FocusedWorkspace', () => {
  let sockets: MockWebSocket[]
  let routes: Map<string, () => Response>
  let attention: AttentionRow[]

  beforeEach(() => {
    localStorage.clear()
    resetLedger()
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
    attention = attentionRows()
    routes = new Map([
      ['/api/me', () => Response.json({ username: 'you', via: 'cookie' })],
      ['/api/sessions', () => Response.json(sessionsList())],
      ['/api/attention', () => Response.json(attention)],
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const path = String(url)
          .replace(/^https?:\/\/[^/]+/, '')
          .split('?')[0]
        const snap = /\/api\/sessions\/([^/]+)\/snapshot/.exec(path)
        if (snap) return Promise.resolve(Response.json(snapshotFor(snap[1])))
        const respond = routes.get(path)
        if (!respond) throw new Error(`unexpected fetch ${path}`)
        return Promise.resolve(respond())
      }),
    )
  })

  afterEach(() => {
    sockets = []
    vi.unstubAllGlobals()
  })

  function renderFocused(initialEntry = '/focused') {
    return render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <Routes>
                <Route path="/focused" element={<FocusedWorkspace />} />
                <Route path="/tile" element={<div>tile</div>} />
              </Routes>
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
  }

  function rail() {
    return screen.getByLabelText('Focus queue')
  }

  // Rows are role=button divs, not native buttons, so queries go through the
  // data attribute to stay ordered and unambiguous.
  function railRows(): HTMLElement[] {
    return [...rail().querySelectorAll<HTMLElement>('[data-session-id]')]
  }

  // The stream connects eagerly; opening the socket lets subscriptions fly.
  async function openSocket() {
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0))
    act(() => sockets[0].open())
    await screen.findByText('dialog session') // attention rows have landed
  }

  it('renders each attention kind under its own section', async () => {
    attention = [...attentionRows(), waitingRow()]
    renderFocused()
    await openSocket()

    const rows = railRows().map((row) => row.textContent ?? '')
    expect(rows[0]).toContain('dialog session')
    expect(rows[0]).toContain('allow write access?')
    expect(rows[1]).toContain('review session')
    expect(rows[1]).toContain('turn complete')
    // agents waiting for a prompt sit in their own Waiting section before the
    // busy rows
    expect(rows[2]).toContain('01WAITIN…')
    expect(rows[2]).toContain('waiting for a prompt')
    expect(rows[3]).toContain('worker session')
    expect(rows[3]).toContain('reading main.go')

    // each section heads itself with the shared title and its own count
    const headings = [...rail().querySelectorAll('.rail-section-title')].map((h) => h.textContent)
    expect(headings).toEqual([
      'Needs input (1)',
      'Ready to review (1)',
      'Waiting (1)',
      'Working (1)',
    ])
  })

  it('shows empty states when nothing lives', async () => {
    attention = []
    renderFocused()

    // the fixed sections still head the rail when every one is empty
    expect(await screen.findByText('Needs input')).toBeInTheDocument()
    expect(screen.getByText('Ready to review')).toBeInTheDocument()
    expect(screen.getByText('Waiting')).toBeInTheDocument()
    expect(screen.getByText('Nothing waits on you.')).toBeInTheDocument()
    expect(screen.getByText('No busy sessions.')).toBeInTheDocument()
    expect(screen.getByText('Select a session from the rail.')).toBeInTheDocument()
  })

  it('opens the selected row in the main pane and swaps on click', async () => {
    renderFocused()
    await openSocket()

    const user = userEvent.setup()
    await user.click(within(rail()).getByText('dialog session'))
    await waitFor(() => {
      const opens = sockets[0].sent.map((raw) => JSON.parse(raw))
      expect(opens).toEqual([{ type: 'subscribe', sessionId: DIALOG }])
    })

    // swapping rows keeps the old subscription warm; the new one joins
    await user.click(within(rail()).getByText('worker session'))
    await waitFor(() => {
      const opens = sockets[0].sent.map((raw) => JSON.parse(raw))
      expect(opens[1]).toEqual({ type: 'subscribe', sessionId: WORKER })
    })
    expect(sockets[0].sent.some((raw) => JSON.parse(raw).type === 'unsubscribe')).toBe(false)
  })

  it('clears a needs-input row from the keyboard', async () => {
    renderFocused()
    await openSocket()

    // no inline check-off renders; acknowledgment happens via the 'r' shortcut
    expect(screen.queryByLabelText(/Mark .* reviewed/)).not.toBeInTheDocument()
    const user = userEvent.setup()
    await user.keyboard('r')

    // the acked dialog leaves the queue; the review row tops it now and the
    // settled session drops to Working with no reason line
    await waitFor(() => expect(screen.queryByText('allow write access?')).not.toBeInTheDocument())
    expect(railRows()[0].textContent).toContain('review session')
    const settled = railRows().find((row) => row.textContent?.includes('dialog session'))
    expect(settled?.textContent).not.toContain('input')
  })

  it('drives the queue with the keyboard: j, k, Enter and r', async () => {
    renderFocused()
    await openSocket()

    const user = userEvent.setup()
    await user.keyboard('j') // dialog -> review
    await user.keyboard('{Enter}') // open the review row

    await waitFor(() => {
      const opens = sockets[0].sent.map((raw) => JSON.parse(raw))
      expect(opens).toEqual([{ type: 'subscribe', sessionId: REVIEW }])
    })

    await user.keyboard('r') // mark reviewed: the reason leaves the queue
    await waitFor(() => expect(screen.queryByText('turn complete')).not.toBeInTheDocument())
  })

  it('mutes workspace keys while the shortcuts overlay is open', async () => {
    renderFocused()
    await openSocket()

    const user = userEvent.setup()
    expect(railRows()[0].getAttribute('data-cursor')).toBe('true')

    await user.keyboard('?')
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()

    // the queue must not move under an overlay the user cannot see through
    await user.keyboard('j')
    expect(railRows()[0].getAttribute('data-cursor')).toBe('true')

    // Escape closes through the overlay's own handling; bindings then return
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument()
    await user.keyboard('j')
    expect(railRows()[1].getAttribute('data-cursor')).toBe('true')
  })

  it('deep-links ?session= into a selection', async () => {
    renderFocused(`/focused?session=${WORKER}`)
    await openSocket()
    await waitFor(() => {
      const opens = sockets[0].sent.map((raw) => JSON.parse(raw))
      expect(opens).toContainEqual({ type: 'subscribe', sessionId: WORKER })
    })
    // the parameter is consumed, leaving a clean URL
    await waitFor(() => expect(window.location.search).toBe(''))
  })

  it('presents a switched row fresh instead of reusing the last view', async () => {
    renderFocused()
    await openSocket()

    const user = userEvent.setup()
    await user.click(within(rail()).getByText('dialog session'))

    // transient chrome opens over the selected session
    await user.click(await screen.findByRole('button', { name: 'Rewind' }))
    expect(
      await screen.findByRole('dialog', { name: 'Rewind to an earlier point' }),
    ).toBeInTheDocument()

    // selecting another row swaps the hosted view for that session's own:
    // no leftover dialog, and the new session subscribes
    await user.click(within(rail()).getByText('worker session'))
    expect(
      screen.queryByRole('dialog', { name: 'Rewind to an earlier point' }),
    ).not.toBeInTheDocument()
    await waitFor(() => {
      const opens = sockets[0].sent.map((raw) => JSON.parse(raw))
      expect(opens).toContainEqual({ type: 'subscribe', sessionId: WORKER })
    })
  })
})

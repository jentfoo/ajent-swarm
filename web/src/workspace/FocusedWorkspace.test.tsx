import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import FocusedWorkspace from './FocusedWorkspace'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'
import { MockWebSocket } from '../test/mockWebSocket'
import { resetQueueEntries } from './attention'
import type { AttentionRow } from '../api/types'

// The rail renders over the real provider stack with fetch and WebSocket
// mocks: mixed attention rows fill the three queues, acting on a row posts
// one acknowledgment and re-reads the digest, and the keyboard drives the
// queue.
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
      kind: 'needs-review',
      reason: 'turn complete',
      since: Date.now() - 60_000,
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
      kind: 'needs-input',
      reason: 'allow write access?',
      since: Date.now() - 30_000,
    },
    {
      sessionId: WORKER,
      pid: 3,
      openInteractions: 0,
      running: true,
      idle: false,
      activity: 'reading main.go',
      kind: 'working',
      reason: 'reading main.go',
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
    kind: 'awaiting',
    reason: 'waiting for a prompt',
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
  let routes: Map<string, (init?: RequestInit) => Response>
  let attention: AttentionRow[]

  beforeEach(() => {
    localStorage.clear()
    resetQueueEntries()
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
      // the server settles the ack, then this device's digest re-reads settled
      [
        '/api/attention/ack',
        (init?: RequestInit) => {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            sessionId: string
            dialogId?: number
            turnEnd?: number
          }
          attention = attention.map((row) => {
            if (row.sessionId !== body.sessionId) return row
            const settled = {
              ...row,
              kind: 'awaiting' as const,
              reason: 'waiting for a prompt',
              since: 0,
            }
            if (body.dialogId !== undefined && row.dialogId === body.dialogId) {
              return { ...settled, ackedDialog: true }
            }
            if (body.turnEnd !== undefined && row.lastTurnEnd === body.turnEnd) {
              return { ...settled, ackedTurn: body.turnEnd }
            }
            return row
          })
          return new Response(null, { status: 204 })
        },
      ],
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const path = String(url)
          .replace(/^https?:\/\/[^/]+/, '')
          .split('?')[0]
        const snap = /\/api\/sessions\/([^/]+)\/snapshot/.exec(path)
        if (snap) return Promise.resolve(Response.json(snapshotFor(snap[1])))
        const respond = routes.get(path)
        if (!respond) throw new Error(`unexpected fetch ${path}`)
        return Promise.resolve(respond(init))
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

  // The stream connects eagerly, opening the socket lets subscriptions fly.
  async function openSocket() {
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0))
    act(() => sockets[0].open())
    await screen.findByText('dialog session') // attention rows have landed
  }

  it('renders three queues with needs merged oldest-first', async () => {
    attention = [...attentionRows(), waitingRow()]
    renderFocused()
    await openSocket()

    // the review's turn ended before the dialog opened, so it leads the
    // merged Needs input queue ahead of the dialog, the waiting agent and the
    // busy row
    const rows = railRows().map((row) => row.textContent ?? '')
    expect(rows[0]).toContain('review session')
    expect(rows[0]).toContain('turn complete')
    expect(rows[1]).toContain('dialog session')
    expect(rows[1]).toContain('allow write access?')
    expect(rows[2]).toContain('01WAITIN…')
    expect(rows[2]).toContain('waiting for a prompt')
    expect(rows[3]).toContain('worker session')
    expect(rows[3]).toContain('reading main.go')

    // rows badge their own kind while the queues carry shared titles
    expect(rows[0]).toContain('review')
    expect(rows[1]).toContain('input')
    expect(rows[2]).toContain('waiting')
    expect(rows[3]).toContain('running')
    const headings = [...rail().querySelectorAll('.rail-section-title')].map((h) => h.textContent)
    expect(headings).toEqual(['Needs input (2)', 'Waiting (1)', 'Working (1)'])
  })

  it('renders rail waits in the shared relative format', async () => {
    attention = [...attentionRows(), waitingRow()]
    renderFocused()
    await openSocket()

    // wait ages share the rewind/run-history dialect: bare durations, never
    // "ago", and rows without a wait stamp render none at all
    const waits = [...rail().querySelectorAll('.rail-wait')].map((w) => w.textContent ?? '')
    expect(waits).toEqual(['1m', expect.stringMatching(/^\d+s$/)])
  })

  it('hides empty queue sections', async () => {
    attention = []
    renderFocused()

    // an all-empty rail renders no section chrome, only the empty notice
    expect(await screen.findByText('Select a session from the rail.')).toBeInTheDocument()
    expect(rail().querySelectorAll('.rail-section-title')).toHaveLength(0)
    expect(screen.getByText('No sessions running')).toBeInTheDocument()
  })

  it('hides sections with no sessions', async () => {
    attention = [attentionRows()[2]] // only the busy worker lands
    renderFocused()
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0))
    act(() => sockets[0].open())
    await screen.findByText('worker session') // attention rows have landed

    const titles = [...rail().querySelectorAll('.rail-section-title')].map((h) => h.textContent)
    expect(titles).toEqual(['Working (1)'])
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

    // swapping rows keeps the old subscription warm, the new one joins
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

    const user = userEvent.setup()
    await user.keyboard('j') // review -> dialog
    await user.keyboard('r')

    // the acked dialog leaves the queue, the review row keeps topping it and
    // the settled session drops to Waiting with no reason line
    await waitFor(() => expect(screen.queryByText('allow write access?')).not.toBeInTheDocument())
    expect(railRows()[0].textContent).toContain('review session')
    const settled = railRows().find((row) => row.textContent?.includes('dialog session'))
    expect(settled?.textContent).not.toContain('input')
  })

  it('offers check-offs only on actionable rows', async () => {
    attention = [...attentionRows(), waitingRow()]
    renderFocused()
    await openSocket()

    // the two needs rows carry one each, waiting and working offer no ack
    const checks = screen.getAllByLabelText(/Mark .* reviewed/)
    expect(checks.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Mark review session reviewed',
      'Mark dialog session reviewed',
    ])
  })

  it('checks a row off from the rail button', async () => {
    renderFocused()
    await openSocket()

    const user = userEvent.setup()
    await user.click(screen.getByLabelText('Mark dialog session reviewed'))

    // the ack posts, the digest re-reads settled and nothing opens: the row
    // drops its reason line and check-off, exactly as the r key settles it
    await waitFor(() => {
      expect(screen.queryByLabelText('Mark dialog session reviewed')).not.toBeInTheDocument()
    })
    await waitFor(() => expect(screen.queryByText('allow write access?')).not.toBeInTheDocument())
    const sent = sockets[0].sent.map((raw) => JSON.parse(raw))
    expect(sent).not.toContainEqual({ type: 'subscribe', sessionId: DIALOG })
  })

  it('checks off from the keyboard on the button', async () => {
    renderFocused()
    await openSocket()

    const user = userEvent.setup()
    screen.getByLabelText('Mark dialog session reviewed').focus()
    await user.keyboard('{Enter}')

    // the row's own Enter binding stands down for its inner control: the
    // native button acknowledges and nothing opens the session
    await waitFor(() => expect(screen.queryByText('allow write access?')).not.toBeInTheDocument())
    const sent = sockets[0].sent.map((raw) => JSON.parse(raw))
    expect(sent).not.toContainEqual({ type: 'subscribe', sessionId: DIALOG })
  })

  it('activates the focused row with Enter and Space', async () => {
    renderFocused()
    await openSocket()

    for (const row of railRows()) expect(row.getAttribute('tabindex')).toBe('0')

    const user = userEvent.setup()
    // focus diverges from the j/k cursor: activation follows focus, not the
    // cursor the workspace Enter binding would answer
    railRows()[1].focus() // dialog row, while the cursor tops on review
    await user.keyboard('{Enter}')
    await waitFor(() => {
      const opens = sockets[0].sent.map((raw) => JSON.parse(raw))
      expect(opens).toEqual([{ type: 'subscribe', sessionId: DIALOG }])
    })

    railRows()[0].focus()
    await user.keyboard(' ') // Space activates like a native button
    await waitFor(() => {
      const opens = sockets[0].sent.map((raw) => JSON.parse(raw))
      expect(opens).toEqual([
        { type: 'subscribe', sessionId: DIALOG },
        { type: 'subscribe', sessionId: REVIEW },
      ])
    })
  })

  it('drives the queue with the keyboard: j, k, Enter and r', async () => {
    renderFocused()
    await openSocket()

    const user = userEvent.setup()
    await user.keyboard('j') // review -> dialog
    await user.keyboard('k') // back to the review row
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

    // Escape closes through the overlay's own handling, bindings then return
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

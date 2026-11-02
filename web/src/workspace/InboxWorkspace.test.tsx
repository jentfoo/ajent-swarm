import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import InboxWorkspace from './InboxWorkspace'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'
import { MockWebSocket } from '../test/mockWebSocket'
import { resetLedger } from './attention'
import type { AttentionRow } from '../api/types'

// The rail renders over the real provider stack with fetch and WebSocket
// mocks: mixed attention rows fill both sections, acting on a row clears it,
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

describe('InboxWorkspace', () => {
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

  function renderInbox(initialEntry = '/inbox') {
    return render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <Routes>
                <Route path="/inbox" element={<InboxWorkspace />} />
                <Route path="/tile" element={<div>tile</div>} />
              </Routes>
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
  }

  function rail() {
    return screen.getByLabelText('Inbox queue')
  }

  // Rows are role=button divs; the check-off inside each is a real button, so
  // queries go through the data attribute to stay ordered and unambiguous.
  function railRows(): HTMLElement[] {
    return [...rail().querySelectorAll<HTMLElement>('[data-session-id]')]
  }

  // The stream connects eagerly; opening the socket lets subscriptions fly.
  async function openSocket() {
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0))
    act(() => sockets[0].open())
    await screen.findByText('dialog session') // attention rows have landed
  }

  it('renders mixed sections: dialogs by oldest wait, reviews, then working', async () => {
    attention = [...attentionRows(), waitingRow()]
    renderInbox()
    await openSocket()

    const rows = railRows().map((row) => row.textContent ?? '')
    expect(rows[0]).toContain('dialog session')
    expect(rows[0]).toContain('allow write access?')
    expect(rows[1]).toContain('review session')
    expect(rows[1]).toContain('turn complete')
    // agents waiting for a prompt sit in Needs input before the busy rows
    expect(rows[2]).toContain('01WAITIN…')
    expect(rows[2]).toContain('waiting for a prompt')
    expect(rows[3]).toContain('worker session')
    expect(rows[3]).toContain('reading main.go')

    // section headers keep their counts: two actionable rows plus one waiting
    expect(within(rail()).getByText('Needs input')).toBeInTheDocument()
    expect(within(rail()).getByText(/Working/)).toBeInTheDocument()
    expect(screen.getByText('(3)')).toBeInTheDocument()
  })

  it('shows empty states when nothing lives', async () => {
    attention = []
    renderInbox()

    expect(await screen.findByText('Nothing waits on you.')).toBeInTheDocument()
    expect(screen.getByText('No busy sessions.')).toBeInTheDocument()
    expect(screen.getByText('Select a session from the rail.')).toBeInTheDocument()
  })

  it('opens the selected row in the main pane and swaps on click', async () => {
    renderInbox()
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

  it('clears a needs-input row by acting through the check-off', async () => {
    renderInbox()
    await openSocket()

    const user = userEvent.setup()
    await user.click(screen.getByLabelText('Mark dialog session reviewed'))

    // the acked dialog leaves the queue; the review row tops it now and the
    // settled session drops to Working with no reason line
    await waitFor(() => expect(screen.queryByText('allow write access?')).not.toBeInTheDocument())
    expect(railRows()[0].textContent).toContain('review session')
    const settled = railRows().find((row) => row.textContent?.includes('dialog session'))
    expect(settled?.textContent).not.toContain('input')
  })

  it('drives the queue with the keyboard: j, k, Enter and r', async () => {
    renderInbox()
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

  it('deep-links ?session= into a selection', async () => {
    renderInbox(`/inbox?session=${WORKER}`)
    await openSocket()
    await waitFor(() => {
      const opens = sockets[0].sent.map((raw) => JSON.parse(raw))
      expect(opens).toContainEqual({ type: 'subscribe', sessionId: WORKER })
    })
    // the parameter is consumed, leaving a clean URL
    await waitFor(() => expect(window.location.search).toBe(''))
  })
})

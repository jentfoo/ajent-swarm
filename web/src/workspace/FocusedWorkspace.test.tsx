import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import FocusedWorkspace from './FocusedWorkspace'
import { ChainDialog } from './ChainDialog'
import { QueueDialog } from './QueueDialog'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'
import { MockWebSocket } from '../test/mockWebSocket'
import { ctlSnapshot } from '../test/ctlSnapshot'
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
      ['/api/saved-sessions', () => Response.json([])],
      ['/api/models/options', () => Response.json([])],
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
        if (snap) return Promise.resolve(Response.json(ctlSnapshot(snap[1])))
        if (/\/api\/sessions\/[^/]+\/entries$/.test(path))
          return Promise.resolve(Response.json({ entries: [] }))
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
              <ChainDialog />
              <QueueDialog />
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

  // The hosted session's header label, what "opened in the main pane" means:
  // every live session keeps a stream subscription now, so frames say nothing
  // about selection.
  function mainHeading(): HTMLElement {
    return document.querySelector('.workspace-main .session-header h1')!
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

  it('shows a chained follow-up under Working, not Waiting', async () => {
    // the queued follow-up session the chain pump holds: the digest row is a
    // plain awaiting wait, but the chain fold moves it into Working with the
    // chained badge and the queue-role line
    attention = [
      {
        sessionId: '01QUEUED0000000000',
        pid: 5,
        openInteractions: 0,
        running: false,
        idle: true,
        kind: 'awaiting',
        reason: 'waiting for a prompt',
        chainedOn: DIALOG,
        chainedOnId: 'chn_1',
      },
    ]
    renderFocused()
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0))
    act(() => sockets[0].open())
    await screen.findByText('queued behind dialog session')

    const row = railRows()[0]
    expect(row.textContent).toContain('chained')
    expect(row.textContent).not.toContain('waiting')
    const headings = [...rail().querySelectorAll('.rail-section-title')].map((h) => h.textContent)
    expect(headings).toEqual(['Working (1)'])
  })

  it('lists a chained session directly below its working parent', async () => {
    // the parent keeps a live turn, the child waits behind it: one Working
    // section, parent first, the queued child immediately after
    attention = [
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
      {
        sessionId: '01QUEUED0000000000',
        pid: 5,
        openInteractions: 0,
        running: false,
        idle: true,
        kind: 'awaiting',
        reason: 'waiting for a prompt',
        chainedOn: WORKER,
        chainedOnId: 'chn_2',
      },
    ]
    renderFocused()
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0))
    act(() => sockets[0].open())
    await screen.findByText('queued behind worker session')

    const ids = railRows().map((row) => row.dataset.sessionId)
    expect(ids).toEqual([WORKER, '01QUEUED0000000000'])
    const headings = [...rail().querySelectorAll('.rail-section-title')].map((h) => h.textContent)
    expect(headings).toEqual(['Working (2)'])
  })

  it('badges a parked prompt queued inside the working queue', async () => {
    attention = attentionRows().map((row) =>
      row.sessionId === WORKER ? { ...row, parked: 1, parkedPrompt: 'run the tests' } : row,
    )
    renderFocused()
    await openSocket()

    const rows = railRows().map((row) => row.textContent ?? '')
    // the turn is live, but the parked prompt owns the badge while the row
    // itself sits in Working
    expect(rows[2]).toContain('worker session')
    expect(rows[2]).toContain('queued')
    expect(rows[2]).not.toContain('running')
    const headings = [...rail().querySelectorAll('.rail-section-title')].map((h) => h.textContent)
    expect(headings).toEqual(['Needs input (2)', 'Working (1)'])
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

    // an all-empty rail renders no section chrome, only the empty notice, and
    // no filter box for a roster with nothing to narrow
    expect(await screen.findByText('Select a session from the rail.')).toBeInTheDocument()
    expect(rail().querySelectorAll('.rail-section-title')).toHaveLength(0)
    expect(screen.getByText('No sessions running')).toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
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
    await waitFor(() => expect(mainHeading().textContent).toContain('dialog session'))

    // swapping rows re-hosts the pane; subscriptions stay warm either way
    await user.click(within(rail()).getByText('worker session'))
    await waitFor(() => expect(mainHeading().textContent).toContain('worker session'))
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
    expect(screen.getByText('Select a session from the rail.')).toBeInTheDocument()
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
    expect(screen.getByText('Select a session from the rail.')).toBeInTheDocument()
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
    await waitFor(() => expect(mainHeading().textContent).toContain('dialog session'))

    railRows()[0].focus()
    await user.keyboard(' ') // Space activates like a native button
    await waitFor(() => expect(mainHeading().textContent).toContain('review session'))
  })

  it('hands focus to the opened session on keyboard activation', async () => {
    renderFocused()
    await openSocket()

    // Enter opens with a handoff: once the selected view can hold a caret,
    // the prompt textarea takes it, never left behind in the rail. The view
    // mounts while its stream connects, so bring that stream live first
    const user = userEvent.setup()
    railRows()[1].focus() // dialog row
    await user.keyboard('{Enter}')

    // the shared stream carries the view's subscribe; a live init answers it
    act(() => {
      sockets[0].message({
        type: 'init',
        sessionId: DIALOG,
        state: ctlSnapshot(DIALOG),
        entries: [],
      })
    })

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveFocus())
  })

  it('leaves focus alone on a pointer selection', async () => {
    renderFocused()
    await openSocket()

    const user = userEvent.setup()
    await user.click(within(rail()).getByText('dialog session'))
    await waitFor(() => expect(mainHeading().textContent).toContain('dialog session'))

    // pointer selection need not force focus: the click stays on the row and
    // the composer never takes the caret
    expect(screen.getByRole('textbox', { name: 'Prompt' })).not.toHaveFocus()
  })

  it('drives the queue with the keyboard: j, k, Enter and r', async () => {
    renderFocused()
    await openSocket()

    const user = userEvent.setup()
    await user.keyboard('j') // review -> dialog
    await user.keyboard('k') // back to the review row
    await user.keyboard('{Enter}') // open the review row

    await waitFor(() => expect(mainHeading().textContent).toContain('review session'))

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

  // dragStub is jsdom's dataTransfer stand-in for the HTML5 gestures.
  const dragStub = { setData: () => {}, effectAllowed: '' }

  // dragEvent builds one drag-phase event jsdom cannot: DragEvent is missing
  // there, so dataTransfer rides a plain event through defineProperty.
  function dragEvent(name: string): Event {
    const ev = new Event(name, { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'dataTransfer', { value: dragStub })
    return ev
  }

  it('chains one row onto another by drag and drop', async () => {
    renderFocused()
    await openSocket()

    const rows = railRows()
    const source = rows[0] // review session
    const target = rows[1] // dialog session

    act(() => {
      source.dispatchEvent(dragEvent('dragstart'))
    })
    // the drag publishes through the shared context before the hover lands
    await act(async () => {})
    act(() => {
      target.dispatchEvent(dragEvent('dragover'))
    })
    // the hovered row is the chain target: highlight, never an insert caret
    expect(target.className).toContain('chain-target')

    act(() => {
      target.dispatchEvent(dragEvent('drop'))
      source.dispatchEvent(new Event('dragend', { bubbles: true }))
    })
    // the shared chain dialog opens with the dragged session queued after
    // the dropped-on parent
    expect(
      await screen.findByRole('dialog', { name: 'Chain review session after dialog session' }),
    ).toBeInTheDocument()
  })

  it('queues a follow-up from a row right-click', async () => {
    renderFocused()
    await openSocket()

    const target = railRows()[1] // dialog session
    fireEvent.contextMenu(target)

    await userEvent
      .setup()
      .click(screen.getByRole('menuitem', { name: 'Queue follow up session…' }))
    expect(
      await screen.findByRole('dialog', { name: 'Queue follow up session after dialog session' }),
    ).toBeInTheDocument()
  })

  it('pins a row into a leading Pinned section from the menu', async () => {
    attention = [...attentionRows(), waitingRow()]
    renderFocused()
    await openSocket()

    // pin the busy worker: it leaves Working and tops the rail in its own
    // section, and the queues re-count without it
    fireEvent.contextMenu(railRows()[3])
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Pin' }))

    await waitFor(() => {
      expect(railRows()[0].dataset.sessionId).toBe(WORKER)
    })
    const headings = [...rail().querySelectorAll('.rail-section-title')].map((h) => h.textContent)
    expect(headings).toEqual(['Pinned (1)', 'Needs input (2)', 'Waiting (1)'])

    // unpinning restores the row to its own queue at the tail
    fireEvent.contextMenu(railRows()[0])
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Unpin' }))
    await waitFor(() => {
      const ids = railRows().map((row) => row.dataset.sessionId)
      expect(ids[ids.length - 1]).toBe(WORKER)
    })
    const restored = [...rail().querySelectorAll('.rail-section-title')].map((h) => h.textContent)
    expect(restored).toEqual(['Needs input (2)', 'Waiting (1)', 'Working (1)'])
  })

  it('keeps pins across a reload in pin order', async () => {
    localStorage.setItem(
      'swarm.workspace.v1',
      JSON.stringify({ focused: { pinnedSessionIds: [WORKER, REVIEW] } }),
    )
    attention = [...attentionRows()]
    renderFocused()
    await openSocket()

    // both pinned sessions top the rail in pin order whatever their state,
    // the keyboard cursor starts on the first of them
    const ids = railRows().map((row) => row.dataset.sessionId)
    expect(ids).toEqual([WORKER, REVIEW, DIALOG])
    expect(railRows()[0].getAttribute('data-cursor')).toBe('true')
    const headings = [...rail().querySelectorAll('.rail-section-title')].map((h) => h.textContent)
    expect(headings).toEqual(['Pinned (2)', 'Needs input (1)'])
  })

  it('never starts a row drag from an inner control', async () => {
    renderFocused()
    await openSocket()

    const check = screen.getByLabelText('Mark dialog session reviewed')
    act(() => {
      check.dispatchEvent(dragEvent('dragstart'))
    })
    // no drag published, so no row highlights and a stray drop chains nothing
    const rows = railRows()
    act(() => {
      rows[0].dispatchEvent(dragEvent('dragover'))
      rows[0].dispatchEvent(dragEvent('drop'))
    })
    expect(railRows().every((row) => !row.className.includes('chain-target'))).toBe(true)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
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

  it('narrows rows without regrouping or re-sorting them', async () => {
    attention = [...attentionRows(), waitingRow()]
    renderFocused()
    await openSocket()

    const user = userEvent.setup()
    const box = screen.getByRole('searchbox', { name: 'Filter sessions' })
    const ids = () => railRows().map((row) => row.dataset.sessionId)

    // one shared letter hits every named row, none hits the waiting row whose
    // label is its short id: the survivors keep the full ranked order
    await user.type(box, 'e')
    expect(ids()).toEqual([REVIEW, DIALOG, WORKER])

    // a narrower query keeps queue membership and counts only survivors
    await user.clear(box)
    await user.type(box, 'dialog')
    expect(ids()).toEqual([DIALOG])
    const headings = [...rail().querySelectorAll('.rail-section-title')].map((h) => h.textContent)
    expect(headings).toEqual(['Needs input (1)'])

    // clearing restores the prior list order
    await user.clear(box)
    expect(ids()).toEqual([REVIEW, DIALOG, '01WAITING00000000', WORKER])
  })

  it('keeps workspace keys out of the filter box', async () => {
    renderFocused()
    await openSocket()

    const user = userEvent.setup()
    const box = screen.getByRole('searchbox', { name: 'Filter sessions' })
    await user.type(box, 'dialog')
    expect(railRows()).toHaveLength(1)
    expect(railRows()[0].getAttribute('data-cursor')).toBe('true')

    // j and r belong to the text field while the caret is in it: the query
    // grows into a miss, and the cursor machinery reads only visible rows
    await user.keyboard('jr')
    expect(box).toHaveValue('dialogjr')
    expect(screen.getByText('No sessions match “dialogjr”.')).toBeInTheDocument()
    expect(rail().querySelectorAll('[data-cursor="true"]')).toHaveLength(0)

    // the first Escape clears the query, the rail returns, keys bind again
    await user.keyboard('{Escape}')
    expect(box).toHaveValue('')
    expect(railRows()).toHaveLength(3)
    expect(railRows()[0].getAttribute('data-cursor')).toBe('true')
  })

  it('moves the cursor within the visible rows and bounds it', async () => {
    attention = [...attentionRows(), waitingRow()]
    renderFocused()
    await openSocket()

    const user = userEvent.setup()
    const box = screen.getByRole('searchbox', { name: 'Filter sessions' })
    await user.type(box, 'dialog')
    expect(railRows()).toHaveLength(1)
    // the cursor falls back to the only visible row
    expect(railRows()[0].getAttribute('data-cursor')).toBe('true')

    // back to the full rail, the cursor falls back to the first row
    await user.clear(box)
    act(() => box.blur())
    expect(railRows()[0].getAttribute('data-cursor')).toBe('true')

    // k past the top and j past the end clamp to the visible bounds
    await user.keyboard('kkk')
    expect(railRows()[0].getAttribute('data-cursor')).toBe('true')
    await user.keyboard('jjjjj')
    expect(railRows()[3].getAttribute('data-cursor')).toBe('true')
  })

  it('opens the cursor within the visible rows with Enter', async () => {
    renderFocused()
    await openSocket()

    const user = userEvent.setup()
    const box = screen.getByRole('searchbox', { name: 'Filter sessions' })

    // the cursor rides the filter: with only the worker row visible, Enter
    // opens it, where an unfiltered press would have opened the review row
    await user.type(box, 'worker')
    act(() => box.blur())
    await user.keyboard('{Enter}')
    await waitFor(() => expect(mainHeading().textContent).toContain('worker session'))
  })

  it('checks off the visible row under the cursor', async () => {
    renderFocused()
    await openSocket()

    const user = userEvent.setup()
    const box = screen.getByRole('searchbox', { name: 'Filter sessions' })

    // narrowing puts the cursor on the only visible row, an unfiltered press
    // would have acked the review row topping the rail
    await user.type(box, 'dialog')
    expect(railRows()[0].getAttribute('data-cursor')).toBe('true')
    act(() => box.blur())
    await user.keyboard('r')

    await waitFor(() => expect(screen.queryByText('allow write access?')).not.toBeInTheDocument())

    // the ack hit the dialog row the filter had made visible, never the review
    // row the unfiltered rail tops with: the settled row alone stays listed
    expect(railRows().map((row) => row.dataset.sessionId)).toEqual([DIALOG])
    expect(railRows()[0].textContent).toContain('waiting for a prompt')

    // clearing shows the untouched review row still topping the full rail
    await user.clear(box)
    await waitFor(() => expect(railRows()).toHaveLength(3))
    expect(railRows()[0].textContent).toContain('review session')
  })

  it('keeps a filtered-out selection displayed without navigating', async () => {
    renderFocused()
    await openSocket()

    const user = userEvent.setup()
    await user.click(within(rail()).getByText('dialog session'))
    await waitFor(() => expect(mainHeading().textContent).toContain('dialog session'))

    // filtering the selected session away leaves the open view untouched
    const box = screen.getByRole('searchbox', { name: 'Filter sessions' })
    await user.type(box, 'worker')
    expect(railRows().map((row) => row.dataset.sessionId)).toEqual([WORKER])
    expect(mainHeading().textContent).toContain('dialog session')

    // clearing brings the row back with its selection highlight
    await user.clear(box)
    await waitFor(() => expect(railRows()).toHaveLength(3))
    expect(within(rail()).getByText('dialog session').closest('.rail-row')).toHaveClass('selected')
    expect(mainHeading().textContent).toContain('dialog session')
  })

  it('separates a filter miss from an empty roster', async () => {
    renderFocused()
    await openSocket()

    const user = userEvent.setup()
    await user.type(screen.getByRole('searchbox', { name: 'Filter sessions' }), 'zzz')
    expect(screen.getByText('No sessions match “zzz”.')).toBeInTheDocument()
    expect(screen.queryByText('No sessions running')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear filter' }))
    expect(screen.getByText('dialog session')).toBeInTheDocument()
  })

  it('keeps pinned rows under the query in Pinned', async () => {
    localStorage.setItem(
      'swarm.workspace.v1',
      JSON.stringify({ focused: { pinnedSessionIds: [WORKER] } }),
    )
    renderFocused()
    await openSocket()

    const headings = () =>
      [...rail().querySelectorAll('.rail-section-title')].map((h) => h.textContent)
    expect(headings()).toEqual(['Pinned (1)', 'Needs input (2)'])

    // the pin never bypasses the query: the pinned row hides with the rest
    const user = userEvent.setup()
    await user.type(screen.getByRole('searchbox', { name: 'Filter sessions' }), 'review')
    expect(headings()).toEqual(['Needs input (1)'])
    expect(railRows().map((row) => row.dataset.sessionId)).toEqual([REVIEW])
  })
})

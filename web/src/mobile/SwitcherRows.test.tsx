import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SwitcherRows } from './SwitcherRows'
import type { SwitcherRow } from './switcher'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'
import { resetLedger } from '../workspace/attention'

// The switcher's interactive contract at its breakpoint: rows group under
// muted desktop-rail headings, long-press rename writes swarm storage and
// suppresses the tap, awaiting rows never offer a check-off, and live
// needs-input rows offer one backed by the digest.

function row(overrides: Partial<SwitcherRow> = {}): SwitcherRow {
  return {
    sessionId: '01A',
    label: 'project',
    status: 'idle',
    section: 'working',
    needsInput: false,
    reason: '',
    checkOff: false,
    ...overrides,
  }
}

const noOpen = () => {}

// stubFacts answers the providers' bootstrap calls; each rendering test also
// awaits one findBy so the settled AuthProvider fetch lands inside act.
function stubFacts() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      if (String(url) === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
      return Response.json([])
    }),
  )
}

// needsInputDialog is one attention digest row with an open dialog, the same
// shape GET /api/attention answers with.
const needsInputDialog = [
  {
    sessionId: '01A',
    pid: 1,
    openInteractions: 1,
    running: false,
    idle: true,
    dialogId: 3,
    dialogPrompt: 'Allow write access?',
    dialogAt: 1_000,
  },
]

describe('SwitcherRows', () => {
  beforeEach(() => {
    localStorage.clear()
    resetLedger()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function tree(rows: SwitcherRow[], onOpen = noOpen) {
    return (
      <MemoryRouter>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <SwitcherRows rows={rows} onOpen={onOpen} />
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>
    )
  }

  function renderRows(rows: SwitcherRow[], onOpen = noOpen) {
    return render(tree(rows, onOpen))
  }

  // sectionOfRow reads the rendered order: headings and rows are siblings, so
  // the last heading before a row names its section, count included.
  function sectionOfRow(container: HTMLElement, sessionId: string): string | null {
    let heading: string | null = null
    const selector = '.rail-section-title, [data-session-id]'
    for (const el of container.querySelectorAll<HTMLElement>(selector)) {
      if (el.classList.contains('rail-section-title')) heading = el.textContent
      else if (el.dataset.sessionId === sessionId) return heading
    }
    return null
  }

  // pressLong holds the row past the rename threshold on fake timers, then
  // releases the way a finger would: pointerup, and a click retargeted to the
  // rows container because the row itself was replaced mid-hold.
  async function pressLong(element: Element) {
    const user = userEvent.setup()
    const container = element.closest('.switcher-rows')!
    vi.useFakeTimers()
    act(() => {
      element.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerId: 1 }),
      )
    })
    await act(() => vi.advanceTimersByTimeAsync(500))
    vi.useRealTimers()
    act(() => {
      element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      container.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    return user
  }

  it('renames through long-press into swarm storage', async () => {
    const fetchSpy = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      if (String(url).endsWith('/title')) {
        return new Response(null, { status: 204 })
      }
      if (String(url) === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
      return Response.json([])
    })
    vi.stubGlobal('fetch', fetchSpy)
    const onOpen = vi.fn()

    renderRows([row()], onOpen)
    await pressLong(screen.getByRole('listitem'))

    // the hold opened the editor and suppressed the tap that opens the session
    const input = await screen.findByDisplayValue('project')
    expect(onOpen).not.toHaveBeenCalled()

    const user = userEvent.setup()
    await user.clear(input)
    await user.type(input, 'couch reading')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await vi.waitFor(() => {
      const titles = fetchSpy.mock.calls.filter(([u]) => String(u).endsWith('/title'))
      expect(titles).toHaveLength(1)
      expect(JSON.parse(String(titles[0]![1]?.body))).toEqual({ title: 'couch reading' })
    })
  })

  it('never offers a check-off on waiting rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url) === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        return Response.json([])
      }),
    )

    renderRows([row({ status: 'waiting', section: 'needs', reason: 'waiting for a prompt' })])
    await screen.findByText('waiting')

    // neutral waiting badge, no actionable control beside it
    expect(screen.queryByRole('button', { name: /reviewed/ })).not.toBeInTheDocument()
  })

  it('offers the check-off on live needs-input rows and counts them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const path = String(url).split('?')[0]
        if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        if (path === '/api/attention') return Response.json(needsInputDialog)
        return Response.json([])
      }),
    )

    renderRows([
      row({ section: 'needs', needsInput: true, reason: 'Allow write access?', checkOff: true }),
      row({ sessionId: '01B', label: 'other' }),
    ])

    // the badge and the check-off both ride the digest; only the dialog row
    await screen.findByText('input')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /reviewed/ }))

    // the check-off landed in the persisted ledger, so the row stays settled
    await vi.waitFor(() => {
      const ledger = JSON.parse(localStorage.getItem('swarm.attention.v1')!)
      expect(ledger.dialogs['01A']['1:3']).toBeGreaterThan(0)
    })
    expect(screen.queryByRole('button', { name: /reviewed/ })).not.toBeInTheDocument()
  })

  it('heads each non-empty section with its count', async () => {
    stubFacts()
    const { container } = renderRows([
      row({ sessionId: '01A', section: 'needs' }),
      row({ sessionId: '01B', label: 'other', section: 'working' }),
      row({ sessionId: '01C', label: 'old', status: 'ended', section: 'ended' }),
    ])

    await screen.findByText('Needs input')
    expect(sectionOfRow(container, '01A')).toBe('Needs input (1)')
    expect(sectionOfRow(container, '01B')).toBe('Working (1)')
    expect(sectionOfRow(container, '01C')).toBe('Recent (1)')
  })

  it('moves rows under the right heading as attention shifts', async () => {
    stubFacts()
    const view = renderRows([
      row({ sessionId: '01A', status: 'waiting', section: 'needs' }),
      row({
        sessionId: '01B',
        label: 'other',
        needsInput: true,
        reason: 'Allow write access?',
        checkOff: true,
        section: 'needs',
      }),
    ])
    await screen.findByText('Needs input')
    expect(sectionOfRow(view.container, '01A')).toBe('Needs input (2)')
    expect(sectionOfRow(view.container, '01B')).toBe('Needs input (2)')

    // one session starts running while the other's dialog closes into its turn
    view.rerender(
      tree([
        row({ sessionId: '01A', status: 'running', section: 'working' }),
        row({ sessionId: '01B', label: 'other', status: 'running', section: 'working' }),
      ]),
    )
    await screen.findByText('Working')
    expect(sectionOfRow(view.container, '01A')).toBe('Working (2)')
    expect(sectionOfRow(view.container, '01B')).toBe('Working (2)')
    expect(screen.queryByText('Needs input')).not.toBeInTheDocument()
  })
})

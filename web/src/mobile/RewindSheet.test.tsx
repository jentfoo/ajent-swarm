import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RewindSheet } from './RewindSheet'
import { RewindDialog } from '../session/RewindDialog'
import type { RewindCandidates } from '../api/types'

// The sheet is the phone chrome over the shared picker body: the same rows the
// desktop dialog lists — every kind, the server's tree order, no cap — a
// pending notice until they arrive, and the full pick contract on tap: success
// toast, truncation warning before the prefill, close.

const ago = (minutes: number): number => Date.now() - minutes * 60_000

const forks: RewindCandidates = {
  head: '04U',
  candidates: [
    {
      id: '01U',
      kind: 'user',
      ts: ago(120),
      isHead: false,
      active: true,
      label: 'create system monitor',
      text: 'create system monitor',
    },
    { id: '02A', kind: 'assistant', ts: ago(96), isHead: false, active: true, label: 'a reply' },
    // the oldest row listed third: the tree walk owns the order, not timestamps
    {
      id: '03C',
      kind: 'compaction',
      ts: ago(200),
      isHead: false,
      active: false,
      label: 'auto-compacted · 14 msgs',
    },
    { id: '04U', kind: 'user', ts: ago(5), isHead: true, active: true, label: 'current prompt' },
  ],
}

const listing: RewindCandidates = {
  head: '01C2',
  candidates: [
    {
      id: '01C1',
      kind: 'user',
      ts: 1000,
      isHead: false,
      label: 'first prompt',
      text: 'first prompt',
    },
    {
      id: '01C2',
      kind: 'user',
      ts: 2000,
      isHead: true,
      label: 'current prompt',
      text: 'current prompt',
    },
  ],
}

// stubCandidates serves one candidates reply and records rewind bodies.
function stubCandidates(reply: () => RewindCandidates): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (!String(url).endsWith('/rewind')) return Response.json(reply())
      if (init?.body) bodies.push(JSON.parse(String(init.body)))
      return Response.json({ head: '01C1' })
    }),
  )
  return bodies
}

function renderSheet() {
  return render(
    <RewindSheet sessionId="01S" open onClose={() => {}} onPrefill={() => {}} onToast={() => {}} />,
  )
}

function rowIDs(root: HTMLElement): string[] {
  return within(root)
    .queryAllByTestId<HTMLElement>(/^rewind-/)
    .map((el) => el.dataset.testid ?? '')
}

describe('RewindSheet', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows a pending notice until candidates arrive', async () => {
    let release!: (reply: RewindCandidates) => void
    const gate = new Promise<RewindCandidates>((resolve) => {
      release = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(await gate)),
    )

    renderSheet()
    expect(screen.getByText('Loading rewind points…')).toBeInTheDocument()
    expect(
      screen.queryByText('Nothing rewirable yet: no prompts, replies or compactions.'),
    ).not.toBeInTheDocument()

    // the empty message belongs to a settled empty list alone
    await act(async () => {
      release({ head: '01C1', candidates: [] })
    })
    expect(screen.queryByText('Loading rewind points…')).not.toBeInTheDocument()
    expect(
      screen.getByText('Nothing rewirable yet: no prompts, replies or compactions.'),
    ).toBeInTheDocument()
  })

  it('clears a load error once a reload succeeds', async () => {
    let fail = true
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fail
          ? Response.json({ error: 'unavailable', message: 'candidates refused' }, { status: 503 })
          : Response.json(listing),
      ),
    )

    const { rerender } = renderSheet()
    expect(await screen.findByText(/candidates refused/)).toBeInTheDocument()

    // close, recover the transport, reopen: the old failure is gone
    fail = false
    rerender(
      <RewindSheet
        sessionId="01S"
        open={false}
        onClose={() => {}}
        onPrefill={() => {}}
        onToast={() => {}}
      />,
    )
    rerender(
      <RewindSheet
        sessionId="01S"
        open
        onClose={() => {}}
        onPrefill={() => {}}
        onToast={() => {}}
      />,
    )

    expect(await screen.findByText('first prompt')).toBeInTheDocument()
    expect(screen.queryByText(/candidates refused/)).not.toBeInTheDocument()
  })

  it('renders the shared row language with the head inert', async () => {
    const user = userEvent.setup()
    const bodies = stubCandidates(() => ({
      head: '01C2',
      candidates: [
        {
          id: '01C1',
          kind: 'user',
          ts: ago(5),
          isHead: false,
          label: 'first prompt',
          text: 'first prompt',
          truncated: true,
        },
        {
          id: '01C2',
          kind: 'user',
          ts: ago(1),
          isHead: true,
          label: 'current prompt',
          text: 'current prompt',
        },
      ],
    }))

    renderSheet()
    const head = await screen.findByTestId('rewind-01C2')
    expect(head).toHaveAttribute('aria-disabled', 'true')
    expect(within(head).getByText('current')).toBeInTheDocument()

    const row = screen.getByTestId('rewind-01C1')
    expect(row).toHaveTextContent('first prompt')
    expect(row).toHaveTextContent('5m ago')
    expect(row).toHaveTextContent('· truncated')
    expect(row.querySelector('.rewind-dot')).toBeInTheDocument()

    // the head row marks the present: tapping it rewinds nowhere
    await user.click(head)
    expect(bodies).toHaveLength(0)
  })

  it('matches the desktop dialog row for row', async () => {
    stubCandidates(() => forks)
    const desktop = render(
      <RewindDialog sessionId="01S" onClose={() => {}} onToast={() => {}} onPrefill={() => {}} />,
    )
    const phone = renderSheet()

    await waitFor(() => expect(rowIDs(desktop.container)).toHaveLength(4))
    expect(rowIDs(phone.container)).toEqual(rowIDs(desktop.container))
    expect(rowIDs(desktop.container)).toEqual([
      'rewind-01U',
      'rewind-02A',
      'rewind-03C',
      'rewind-04U',
    ])
  })

  it('lists every candidate without a cap', async () => {
    stubCandidates(() => ({
      head: 'u29',
      candidates: Array.from({ length: 30 }, (_, i) => ({
        id: `u${String(i).padStart(2, '0')}`,
        kind: 'user' as const,
        ts: ago(60 - i),
        isHead: i === 29,
        label: `prompt ${i}`,
        text: `prompt ${i}`,
      })),
    }))
    const { container } = renderSheet()

    await waitFor(() => expect(rowIDs(container)).toHaveLength(30))
  })

  it('warns before a truncated prefill', async () => {
    const user = userEvent.setup()
    const bodies = stubCandidates(() => ({
      head: '02U',
      candidates: [
        {
          id: '01U',
          kind: 'user',
          ts: ago(3),
          isHead: false,
          label: 'big',
          text: 'big…',
          truncated: true,
        },
        { id: '02U', kind: 'user', ts: ago(1), isHead: true, label: 'head prompt' },
      ],
    }))
    const onClose = vi.fn()
    const onToast = vi.fn()
    const onPrefill = vi.fn()
    render(
      <RewindSheet
        sessionId="01S"
        open
        onClose={onClose}
        onToast={onToast}
        onPrefill={onPrefill}
      />,
    )

    await user.click(await screen.findByTestId('rewind-01U'))
    await vi.waitFor(() => expect(bodies.at(-1)).toEqual({ head: '01U' }))
    expect(onToast).toHaveBeenCalledWith('Rewound onto user.', 'info')
    expect(onToast).toHaveBeenCalledWith('The prompt was too large to prefill in full.', 'error')
    // the warning lands before the prefill does
    expect(onToast.mock.invocationCallOrder[1]).toBeLessThan(onPrefill.mock.invocationCallOrder[0])
    expect(onPrefill).toHaveBeenCalledWith('big…')
    expect(onClose).toHaveBeenCalled()
  })
})

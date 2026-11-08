import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RewindDialog } from './RewindDialog'
import type { RewindCandidates } from '../api/types'

// The desktop picker renders the server's tree rows and drives them
// keyboard-first: a cursor over the pickable rows, Enter rewinds, the head row
// stays visible but inert, and the prefill contract is unchanged.

const ago = (minutes: number): number => Date.now() - minutes * 60_000

const tree: RewindCandidates = {
  head: '01C4',
  candidates: [
    {
      id: '01C1',
      kind: 'user',
      ts: ago(120),
      isHead: false,
      active: true,
      label: 'create system monitor',
      text: 'create system monitor',
    },
    {
      id: '01C2',
      kind: 'assistant',
      ts: ago(96),
      isHead: false,
      active: true,
      guide: '└── ',
      label: "It's not done, but updated",
    },
    {
      id: '01C3',
      kind: 'compaction',
      ts: ago(90),
      isHead: false,
      active: false,
      depth: 1,
      guide: '    ├── ',
      label: 'auto-compacted · 14 msgs',
    },
    {
      id: '01C4',
      kind: 'user',
      ts: ago(5),
      isHead: true,
      active: true,
      label: 'current prompt',
      text: 'current prompt',
    },
  ],
}

function rowFor(text: string): HTMLElement {
  const row = screen.getByText(text).closest<HTMLElement>('.rewind-row')
  if (row === null) throw new Error(`no rewind row carries ${text}`)
  return row
}

function stubAPI(
  candidates: () => Response,
  rewind: () => Response = () => Response.json({ head: '01C1' }),
): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (!String(url).endsWith('/rewind')) return candidates()
      if (init?.body) bodies.push(JSON.parse(String(init.body)))
      return rewind()
    }),
  )
  return bodies
}

function renderDialog() {
  const onClose = vi.fn()
  const onToast = vi.fn()
  const onPrefill = vi.fn()
  render(<RewindDialog sessionId="01S" onClose={onClose} onToast={onToast} onPrefill={onPrefill} />)
  return { onClose, onToast, onPrefill }
}

describe('RewindDialog', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the tree with tags, guides and ages', async () => {
    stubAPI(() => Response.json(tree))

    renderDialog()
    expect(await screen.findByText('create system monitor')).toBeInTheDocument()
    expect(screen.getByText('reply')).toBeInTheDocument()
    expect(screen.getByText('compaction')).toBeInTheDocument()
    expect(screen.getByText('2h ago')).toBeInTheDocument()
    expect(screen.getByText('96m ago')).toBeInTheDocument()
    // inline connectors render, blank continuation runs and all
    expect(screen.getByText('└──')).toBeInTheDocument()
    expect(screen.getByText('├──')).toBeInTheDocument()

    // off the active branch recedes without a badge
    expect(rowFor('auto-compacted · 14 msgs')).toHaveClass('off')

    // the head carries the one marker and stays inert
    const head = rowFor('current prompt')
    expect(head).toHaveClass('head')
    expect(head).toHaveAttribute('aria-disabled', 'true')
    expect(within(head).getByText('current')).toBeInTheDocument()
  })

  it('moves the cursor from beside the head and rewinds on Enter', async () => {
    const user = userEvent.setup()
    const bodies = stubAPI(() => Response.json(tree))
    const { onPrefill } = renderDialog()
    await screen.findByText('create system monitor')

    // the cursor opens on the newest pickable row, next to the head
    expect(rowFor('auto-compacted · 14 msgs')).toHaveAttribute('data-cursor', 'true')

    await user.keyboard('k')
    expect(rowFor("It's not done, but updated")).toHaveAttribute('data-cursor', 'true')

    await user.keyboard('{Enter}')
    await vi.waitFor(() => expect(bodies.at(-1)).toEqual({ head: '01C2' }))
    expect(onPrefill).not.toHaveBeenCalled() // replies carry no prompt text
  })

  it('rewinds a clicked prompt and prefills its text', async () => {
    const user = userEvent.setup()
    const bodies = stubAPI(() => Response.json(tree))
    const { onClose, onToast, onPrefill } = renderDialog()
    await screen.findByText('create system monitor')

    await user.click(screen.getByText('create system monitor'))
    await vi.waitFor(() => expect(bodies.at(-1)).toEqual({ head: '01C1' }))
    expect(onPrefill).toHaveBeenCalledWith('create system monitor')
    expect(onClose).toHaveBeenCalled()
    expect(onToast).toHaveBeenCalledWith('Rewound onto user.', 'info')
  })

  it('flags a prompt too large to prefill', async () => {
    const user = userEvent.setup()
    const listing: RewindCandidates = {
      head: '01C2',
      candidates: [
        {
          id: '01C1',
          kind: 'user',
          ts: ago(3),
          isHead: false,
          active: true,
          label: 'big',
          text: 'big',
          truncated: true,
        },
        {
          id: '01C2',
          kind: 'user',
          ts: ago(1),
          isHead: true,
          active: true,
          label: 'head prompt',
          text: 'head prompt',
        },
      ],
    }
    stubAPI(() => Response.json(listing))
    const { onToast } = renderDialog()

    // the row flags its cut tail before the pick ever warns
    expect(await screen.findByText('big')).toBeInTheDocument()
    expect(screen.getByTestId('rewind-01C1')).toHaveTextContent('· truncated')

    await user.click(screen.getByText('big'))
    await vi.waitFor(() =>
      expect(onToast).toHaveBeenCalledWith('The prompt was too large to prefill in full.', 'error'),
    )
  })

  it('leaves Enter to a focused footer button', async () => {
    const user = userEvent.setup()
    const bodies = stubAPI(() => Response.json(tree))
    const { onClose } = renderDialog()
    await screen.findByText('create system monitor')

    await user.tab() // ModalShell walks focus onto the footer button
    await user.keyboard('{Enter}')

    expect(onClose).toHaveBeenCalled()
    expect(bodies).toHaveLength(0)
  })

  it('ignores the head row', async () => {
    const user = userEvent.setup()
    const bodies = stubAPI(() => Response.json(tree))
    const { onClose } = renderDialog()
    await screen.findByText('current prompt')

    await user.click(screen.getByText('current prompt'))
    expect(bodies).toHaveLength(0)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps the picker open on a refusal', async () => {
    const user = userEvent.setup()
    stubAPI(
      () => Response.json(tree),
      () => Response.json({ error: 'busy', message: 'a turn is running' }, { status: 409 }),
    )
    const { onClose, onToast } = renderDialog()
    await screen.findByText('create system monitor')

    await user.click(screen.getByText('create system monitor'))
    await vi.waitFor(() => expect(onToast).toHaveBeenCalledWith('busy: a turn is running', 'error'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('surfaces a load error', async () => {
    stubAPI(() =>
      Response.json({ error: 'unavailable', message: 'candidates refused' }, { status: 503 }),
    )
    renderDialog()

    expect(await screen.findByText(/candidates refused/)).toBeInTheDocument()
    expect(screen.queryByText('create system monitor')).not.toBeInTheDocument()
  })
})

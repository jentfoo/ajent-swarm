import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RewindList } from './RewindList'
import type { RewindCandidates } from '../api/types'

// The shared picker body both chromes ride: every kind lists in the server's
// tree order, the keyboard cursor answers only when asked, and one pick
// rewinds, toasts, prefills and closes, or surfaces the refusal and stays.

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

function stubAPI(
  candidates: () => Response,
  rewind: () => Response = () => Response.json({ head: '01U' }),
): { bodies: Record<string, unknown>[]; fetchMock: ReturnType<typeof vi.fn> } {
  const bodies: Record<string, unknown>[] = []
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (!String(url).endsWith('/rewind')) return candidates()
    if (init?.body) bodies.push(JSON.parse(String(init.body)))
    return rewind()
  })
  vi.stubGlobal('fetch', fetchMock)
  return { bodies, fetchMock }
}

function renderList(keyboard = false) {
  const onClose = vi.fn()
  const onToast = vi.fn()
  const onPrefill = vi.fn()
  render(
    <RewindList
      sessionId="01S"
      keyboard={keyboard}
      onClose={onClose}
      onToast={onToast}
      onPrefill={onPrefill}
    />,
  )
  return { onClose, onToast, onPrefill }
}

function rowIDs(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="rewind-"]')).map(
    (el) => el.dataset.testid ?? '',
  )
}

describe('RewindList', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists every kind in tree order', async () => {
    stubAPI(() => Response.json(forks))
    renderList()

    await screen.findByTestId('rewind-04U')
    expect(rowIDs()).toEqual(['rewind-01U', 'rewind-02A', 'rewind-03C', 'rewind-04U'])
    expect(screen.getByTestId('rewind-03C')).toHaveTextContent('auto-compacted · 14 msgs')
    expect(screen.getByTestId('rewind-03C')).toHaveClass('off')
  })

  it('rewinds a picked row and closes', async () => {
    const user = userEvent.setup()
    const { bodies } = stubAPI(() => Response.json(forks))
    const { onClose, onToast, onPrefill } = renderList()
    await screen.findByTestId('rewind-01U')

    await user.click(screen.getByTestId('rewind-01U'))
    await vi.waitFor(() => expect(bodies.at(-1)).toEqual({ head: '01U' }))
    expect(onToast).toHaveBeenCalledWith('Rewound onto user.', 'info')
    expect(onPrefill).toHaveBeenCalledWith('create system monitor')
    expect(onClose).toHaveBeenCalled()
  })

  it('ignores the head row', async () => {
    const user = userEvent.setup()
    const { bodies } = stubAPI(() => Response.json(forks))
    const { onClose } = renderList()
    await screen.findByTestId('rewind-04U')

    await user.click(screen.getByTestId('rewind-04U'))
    expect(bodies).toHaveLength(0)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps the list open on a refusal', async () => {
    const user = userEvent.setup()
    stubAPI(
      () => Response.json(forks),
      () => Response.json({ error: 'busy', message: 'a turn is running' }, { status: 409 }),
    )
    const { onClose, onToast, onPrefill } = renderList()
    await screen.findByTestId('rewind-01U')

    await user.click(screen.getByTestId('rewind-01U'))
    await vi.waitFor(() => expect(onToast).toHaveBeenCalledWith('a turn is running', 'error'))
    expect(onClose).not.toHaveBeenCalled()
    expect(onPrefill).not.toHaveBeenCalled()
  })

  it('moves the cursor and picks on keys', async () => {
    const user = userEvent.setup()
    const { bodies } = stubAPI(() => Response.json(forks))
    const { onPrefill } = renderList(true)
    await screen.findByTestId('rewind-01U')

    // the cursor opens beside the head, arrows climb, Enter picks beneath it
    expect(screen.getByTestId('rewind-03C')).toHaveAttribute('data-cursor', 'true')
    await user.keyboard('{ArrowUp}')
    expect(screen.getByTestId('rewind-02A')).toHaveAttribute('data-cursor', 'true')
    await user.keyboard('{Enter}')
    await vi.waitFor(() => expect(bodies.at(-1)).toEqual({ head: '02A' }))
    expect(onPrefill).not.toHaveBeenCalled() // replies carry no prompt text
  })

  it('leaves keys unclaimed without the cursor', async () => {
    const { fetchMock } = stubAPI(() => Response.json(forks))
    renderList(false)
    await screen.findByTestId('rewind-01U')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))

    expect(fetchMock).toHaveBeenCalledTimes(1) // the candidates load alone
    expect(screen.getByTestId('rewind-03C')).not.toHaveAttribute('data-cursor')
  })

  it('one rewind per commit window', async () => {
    const { bodies } = stubAPI(() => Response.json(forks))
    const { onClose, onToast, onPrefill } = renderList()
    const row = await screen.findByTestId('rewind-01U')

    // two clicks inside one commit window: neither sees the other's busyId,
    // only one rewind may start
    await act(async () => {
      row.click()
      row.click()
    })

    expect(bodies).toEqual([{ head: '01U' }])
    expect(onToast).toHaveBeenCalledTimes(1)
    expect(onPrefill).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('one rewind per key repeat', async () => {
    const { bodies } = stubAPI(() => Response.json(forks))
    const { onClose, onToast, onPrefill } = renderList(true)
    await screen.findByTestId('rewind-01U')

    // held Enter repeats before the busy state commits: only the first lands,
    // and it picks beneath the cursor that opens beside the head
    await act(async () => {
      for (let i = 0; i < 3; i++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      }
    })

    expect(bodies).toEqual([{ head: '03C' }])
    expect(onToast).toHaveBeenCalledTimes(1)
    expect(onPrefill).not.toHaveBeenCalled() // replies carry no prompt text
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('retries after a refused pick', async () => {
    const user = userEvent.setup()
    let attempts = 0
    stubAPI(
      () => Response.json(forks),
      () => {
        attempts++
        return attempts === 1
          ? Response.json({ error: 'busy', message: 'a turn is running' }, { status: 409 })
          : Response.json({ head: '01U' })
      },
    )
    const { onClose, onToast, onPrefill } = renderList()
    const row = await screen.findByTestId('rewind-01U')

    await user.click(row)
    await vi.waitFor(() => expect(onToast).toHaveBeenCalledWith('a turn is running', 'error'))

    // the guard frees once the refusal lands, so a retry can go out
    await user.click(row)
    await vi.waitFor(() => expect(onToast).toHaveBeenCalledWith('Rewound onto user.', 'info'))
    expect(onPrefill).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalled()
  })

  it('warns before a truncated prefill', async () => {
    const user = userEvent.setup()
    stubAPI(() =>
      Response.json({
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
      }),
    )
    const { onClose, onToast, onPrefill } = renderList()

    await user.click(await screen.findByTestId('rewind-01U'))
    await vi.waitFor(() =>
      expect(onToast).toHaveBeenCalledWith('The prompt was too large to prefill in full.', 'error'),
    )
    // the warning lands before the prefill does
    expect(onToast.mock.invocationCallOrder[1]).toBeLessThan(onPrefill.mock.invocationCallOrder[0])
    expect(onPrefill).toHaveBeenCalledWith('big…')
    expect(onClose).toHaveBeenCalled()
  })

  it('surfaces a load error', async () => {
    stubAPI(() =>
      Response.json({ error: 'unavailable', message: 'candidates refused' }, { status: 503 }),
    )
    renderList()

    expect(await screen.findByText(/candidates refused/)).toBeInTheDocument()
    expect(screen.queryByTestId('rewind-01U')).not.toBeInTheDocument()
  })
})

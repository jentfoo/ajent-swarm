import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TranscriptPreview } from './TranscriptPreview'
import type { Entry, SavedEntriesPage } from '../api/types'

// The preview pages a recorded transcript back in time: the newest window
// loads on mount, older pages ride the cursor, and a page fetch can neither
// double-fire, survive a retry failure, nor leak across a session switch.
function messageEntry(id: string, role: 'user' | 'assistant', text: string): Entry {
  return {
    id,
    type: 'message',
    ts: 1730000000000,
    data: { message: { role, content: [{ type: 'text', data: { text } }] } },
  }
}

const pageA: SavedEntriesPage = {
  sessionId: 'sA',
  head: 'e2',
  entries: [
    messageEntry('e1', 'user', 'hello there'),
    messageEntry('e2', 'assistant', 'hi friend'),
  ],
  cursor: 'e1',
}
const olderA: SavedEntriesPage = {
  sessionId: 'sA',
  head: 'e0',
  entries: [messageEntry('e0', 'user', 'old message')],
  cursor: '',
}
const pageB: SavedEntriesPage = {
  sessionId: 'sB',
  head: 'b1',
  entries: [messageEntry('b1', 'user', 'branch entry')],
  cursor: 'b1',
}
const olderB: SavedEntriesPage = {
  sessionId: 'sB',
  head: 'b0',
  entries: [messageEntry('b0', 'user', 'deep b entry')],
  cursor: '',
}

const firstPages: Record<string, SavedEntriesPage> = { sA: pageA, sB: pageB }

// Older pages park here until a test answers them, so the in-flight window is
// observable. The count of parked fetches doubles as the request counter.
let olderReplies: Array<(r: Response) => void> = []

describe('TranscriptPreview', () => {
  beforeEach(() => {
    olderReplies = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const path = String(url)
        const base = path.split('?')[0]
        if (!/\/api\/saved-sessions\/[^/]+\/entries$/.test(base)) {
          throw new Error(`unexpected fetch ${path}`)
        }
        const before = new URLSearchParams(path.split('?')[1] ?? '').get('before') ?? ''
        if (before !== '') {
          return new Promise<Response>((resolve) => {
            olderReplies.push(resolve)
          })
        }
        const id = decodeURIComponent(base.split('/').at(-2)!)
        const page = firstPages[id]
        if (page === undefined) throw new Error(`no first page for ${id}`)
        return Promise.resolve(Response.json(page))
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function replyOlder(page: SavedEntriesPage) {
    olderReplies.shift()!(Response.json(page))
  }

  function replyOlderFailure() {
    olderReplies.shift()!(
      Response.json({ error: 'internal_error', message: 'disk on fire' }, { status: 500 }),
    )
  }

  it('renders the newest window and pages back on demand', async () => {
    const user = userEvent.setup()
    render(<TranscriptPreview sessionId="sA" />)

    expect(await screen.findByText('hi friend')).toBeInTheDocument()
    expect(screen.queryByText('old message')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Load earlier history' }))
    await waitFor(() => expect(olderReplies).toHaveLength(1))
    replyOlder(olderA)

    expect(await screen.findByText('old message')).toBeInTheDocument()
    expect(screen.getByText('hi friend')).toBeInTheDocument()
    // the cursor ran out, so the pager disappears
    expect(screen.queryByRole('button', { name: 'Load earlier history' })).not.toBeInTheDocument()
  })

  it('ignores double clicks while a page fetch is in flight', async () => {
    const user = userEvent.setup()
    render(<TranscriptPreview sessionId="sA" />)
    await screen.findByText('hi friend')

    const pager = () => screen.getByRole('button', { name: 'Load earlier history' })
    await user.click(pager())
    await waitFor(() => expect(olderReplies).toHaveLength(1))
    expect(pager()).toBeDisabled()

    await user.click(pager()) // disabled while parked, so no second fetch
    replyOlder(olderA)

    expect(await screen.findByText('old message')).toBeInTheDocument()
    expect(screen.getAllByText('old message')).toHaveLength(1)
  })

  it('clears a failed page error once a retry succeeds', async () => {
    const user = userEvent.setup()
    render(<TranscriptPreview sessionId="sA" />)
    await screen.findByText('hi friend')

    const pager = () => screen.getByRole('button', { name: 'Load earlier history' })
    await user.click(pager())
    await waitFor(() => expect(olderReplies).toHaveLength(1))
    replyOlderFailure()
    expect(await screen.findByText(/disk on fire/)).toBeInTheDocument()
    expect(pager()).toBeEnabled() // the cursor survived the failure

    await user.click(pager())
    await waitFor(() => expect(olderReplies).toHaveLength(1))
    replyOlder(olderA)

    expect(await screen.findByText('old message')).toBeInTheDocument()
    expect(screen.queryByText(/disk on fire/)).not.toBeInTheDocument()
  })

  it('retires an in flight page when the session switches', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<TranscriptPreview sessionId="sA" />)
    await screen.findByText('hi friend')

    await user.click(screen.getByRole('button', { name: 'Load earlier history' }))
    await waitFor(() => expect(olderReplies).toHaveLength(1))

    rerender(<TranscriptPreview sessionId="sB" />)
    expect(await screen.findByText('branch entry')).toBeInTheDocument()

    // session A's parked reply lands late, against session B's view
    replyOlder(olderA)
    await act(async () => {})
    expect(screen.queryByText('old message')).not.toBeInTheDocument()
    expect(screen.getByText('branch entry')).toBeInTheDocument()

    // B's own pager works: the retired fetch left no stuck in-flight guard
    await user.click(screen.getByRole('button', { name: 'Load earlier history' }))
    await waitFor(() => expect(olderReplies).toHaveLength(1))
    replyOlder(olderB)
    expect(await screen.findByText('deep b entry')).toBeInTheDocument()
  })
})

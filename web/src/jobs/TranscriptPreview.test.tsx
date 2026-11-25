import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TranscriptPreview } from './TranscriptPreview'
import type { Entry, SavedEntriesPage } from '../api/types'

// The preview pages a recorded transcript back in time: the newest window
// loads on mount, older pages ride the cursor, and a page fetch can neither
// double-fire, survive a retry failure, nor leak across a session switch.
// Reading position holds across all of it: the newest window opens on its
// latest entry, a prepend keeps the previously first block's viewport spot,
// and the scroller is whatever the scroll-owner contract names.
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

  it('marks the newest window busy until it lands', async () => {
    let release!: (r: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          }),
      ),
    )
    render(<TranscriptPreview sessionId="sA" />)

    const loading = screen.getByText('Loading the transcript…')
    expect(loading).toHaveAttribute('role', 'status')
    expect(loading).toHaveAttribute('aria-busy', 'true')

    // the paragraph unmounts once entries land, so nothing stays busy
    release(Response.json(pageA))
    await screen.findByText('hi friend')
    expect(screen.queryByText('Loading the transcript…')).not.toBeInTheDocument()
  })

  it('renders the newest window and pages back on demand', async () => {
    const user = userEvent.setup()
    render(<TranscriptPreview sessionId="sA" />)
    stubScroller(scrollerEl(), 4000)

    expect(await screen.findByText('hi friend')).toBeInTheDocument()
    expect(screen.queryByText('old message')).not.toBeInTheDocument()
    // the pager leads the entries, and the newest window opened on its latest
    const pager = screen.getByRole('button', { name: 'Load earlier history' })
    expect(
      pager.compareDocumentPosition(entryEl('e1')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(scrollerEl().scrollTop).toBe(4000)

    await user.click(pager)
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
    // the pending read disables the control and says so
    const pending = screen.getByRole('button', { name: 'Loading earlier history…' })
    expect(pending).toBeDisabled()

    await user.click(pending) // disabled while parked, so no second fetch
    fireEvent.click(pending) // a stray activation meets the same guard
    expect(olderReplies).toHaveLength(1)
    replyOlder(olderA)

    expect(await screen.findByText('old message')).toBeInTheDocument()
    expect(screen.getAllByText('old message')).toHaveLength(1)
    expect(
      screen.queryByRole('button', { name: 'Loading earlier history…' }),
    ).not.toBeInTheDocument()
  })

  it('keeps the reader anchored across a prepend', async () => {
    const user = userEvent.setup()
    render(<TranscriptPreview sessionId="sA" />)
    stubScroller(scrollerEl(), 5000)
    await screen.findByText('hi friend')
    expect(scrollerEl().scrollTop).toBe(5000)

    const anchor = placeRect(entryEl('e1'), 120)
    await user.click(screen.getByRole('button', { name: 'Load earlier history' }))
    await waitFor(() => expect(olderReplies).toHaveLength(1))

    // the prepend lands the anchored block 500px lower in the viewport
    anchor.mockReturnValue(rectAt(620))
    replyOlder(olderA)

    expect(await screen.findByText('old message')).toBeInTheDocument()
    // the scroller absorbed exactly the prepend's push, so the same text sits
    // under the reader; the tail pin never fired again
    expect(scrollerEl().scrollTop).toBe(5000 + 500)
  })

  it('does not re-pin on failures or later pages', async () => {
    const user = userEvent.setup()
    render(<TranscriptPreview sessionId="sA" />)
    stubScroller(scrollerEl(), 4000)
    await screen.findByText('hi friend')
    expect(scrollerEl().scrollTop).toBe(4000)

    const pager = () => screen.getByRole('button', { name: 'Load earlier history' })
    await user.click(pager())
    await waitFor(() => expect(olderReplies).toHaveLength(1))
    replyOlderFailure()
    expect(await screen.findByText(/disk on fire/)).toBeInTheDocument()
    // the failure flipped error state without moving the reader
    expect(scrollerEl().scrollTop).toBe(4000)

    // the retry prepends through the anchor, never a fresh pin to the tail
    const anchor = placeRect(entryEl('e1'), 100)
    await user.click(pager())
    await waitFor(() => expect(olderReplies).toHaveLength(1))
    anchor.mockReturnValue(rectAt(450))
    replyOlder(olderA)
    expect(await screen.findByText('old message')).toBeInTheDocument()
    expect(scrollerEl().scrollTop).toBe(4000 + 350)
  })

  it('measures a parent-owned scroller', async () => {
    const user = userEvent.setup()
    render(<OwnedPreview />)
    const owner = screen.getByTestId('scroll-owner')
    stubScroller(owner, 6000)
    await screen.findByText('hi friend')
    // pinned in the owner, not in the preview's own uncapped root
    expect(owner.scrollTop).toBe(6000)

    const anchor = placeRect(entryEl('e1'), 200)
    await user.click(screen.getByRole('button', { name: 'Load earlier history' }))
    await waitFor(() => expect(olderReplies).toHaveLength(1))
    anchor.mockReturnValue(rectAt(700))
    replyOlder(olderA)

    expect(await screen.findByText('old message')).toBeInTheDocument()
    expect(owner.scrollTop).toBe(6000 + 500)
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
    const scroller = scrollerEl()
    stubScroller(scroller, 5000)
    await screen.findByText('hi friend')
    expect(scroller.scrollTop).toBe(5000)

    await user.click(screen.getByRole('button', { name: 'Load earlier history' }))
    await waitFor(() => expect(olderReplies).toHaveLength(1))

    rerender(<TranscriptPreview sessionId="sB" />)
    stubScroller(scroller, 3000)
    expect(await screen.findByText('branch entry')).toBeInTheDocument()
    // the new walk pins to its own latest, not session A's position
    expect(scroller.scrollTop).toBe(3000)

    // session A's parked reply lands late, against session B's view
    replyOlder(olderA)
    await act(async () => {})
    expect(screen.queryByText('old message')).not.toBeInTheDocument()
    expect(screen.getByText('branch entry')).toBeInTheDocument()
    expect(scroller.scrollTop).toBe(3000) // the stale page moved nobody

    // B's own pager works: the retired fetch left no stuck in-flight guard
    await user.click(screen.getByRole('button', { name: 'Load earlier history' }))
    await waitFor(() => expect(olderReplies).toHaveLength(1))
    replyOlder(olderB)
    expect(await screen.findByText('deep b entry')).toBeInTheDocument()
  })
})

// The scroll-owner contract's other half: RunDetail hands its modal card over
// with this shape, so the preview measures and adjusts that element.
function OwnedPreview(): ReactElement {
  const owner = useRef<HTMLDivElement>(null)
  return (
    <div ref={owner} data-testid="scroll-owner">
      <TranscriptPreview sessionId="sA" scrollOwner={owner} />
    </div>
  )
}

// jsdom lays nothing out: the scroller's box stands in for layout, so the
// pin and the restore write against a known height.
function stubScroller(el: HTMLElement, scrollHeight: number) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 300 })
}

function scrollerEl(): HTMLElement {
  return document.querySelector('.transcript-preview') as HTMLElement
}

function entryEl(id: string): HTMLElement {
  return document.querySelector(`[data-entry-id="${id}"]`) as HTMLElement
}

function rectAt(top: number): DOMRect {
  return {
    width: 100,
    height: 40,
    left: 0,
    right: 100,
    top,
    bottom: top + 40,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

function placeRect(el: HTMLElement, top: number) {
  return vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rectAt(top))
}

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { HistorySearchOverlay } from './HistorySearchOverlay'
import { openSearch, searchKey } from './historySearch'
import type { HistorySearch } from './historySearch'

// The overlay is pure presentation over the machine: blank until typed, a
// "no match" note when narrowing empties, matches with emphasized spans, and
// click or tap accepting the pressed row.

const items = ['fix the retry loop', 'retry the shipping step', 'ship v2']

// narrowed builds the state after typing query, as the composer does.
function narrowed(items: string[], query: string): HistorySearch {
  let s = openSearch(items)
  for (const ch of query) s = searchKey(s, { type: 'input', text: ch }).search
  return s
}

function renderOverlay(search: HistorySearch) {
  const onHighlight = vi.fn()
  const onAccept = vi.fn()
  const onClose = vi.fn()
  const view = render(
    <HistorySearchOverlay
      search={search}
      onHighlight={onHighlight}
      onAccept={onAccept}
      onClose={onClose}
    />,
  )
  return { onHighlight, onAccept, onClose, view }
}

describe('HistorySearchOverlay', () => {
  it('blank query shows the echo only', () => {
    renderOverlay(openSearch(items))

    expect(screen.getByText(/reverse-i-search/)).toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.queryByText('no match')).not.toBeInTheDocument()
  })

  it('shows the empty note when nothing matches', () => {
    renderOverlay(narrowed(items, 'zzz'))

    expect(screen.getByText('no match')).toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('lists matches with the query emphasized', () => {
    renderOverlay(narrowed(items, 'retry'))

    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(options[1]).toHaveAttribute('aria-selected', 'false')
    // the matched substring rides a mark in the newest hit
    expect(options[0]!.querySelector('mark')).toHaveTextContent('retry')
  })

  it('accepts the pressed row, not just the highlighted one', async () => {
    const user = userEvent.setup()
    const { onAccept } = renderOverlay(narrowed(items, 'ship'))

    const options = screen.getAllByRole('option')
    await user.click(options[1]!)
    expect(onAccept).toHaveBeenCalledOnce()
    expect(onAccept.mock.calls[0]![0]).toBe('ship v2')
  })

  it('hover moves the highlight through onHighlight', async () => {
    const user = userEvent.setup()
    const { onHighlight } = renderOverlay(narrowed(items, 'retry'))

    await user.hover(screen.getAllByRole('option')[1]!)
    expect(onHighlight).toHaveBeenCalledOnce()
    expect(onHighlight.mock.calls[0]![0]).toBe(1)
  })

  it('the close affordance closes without accepting', async () => {
    const user = userEvent.setup()
    const { onClose, onAccept } = renderOverlay(narrowed(items, 'retry'))

    await user.click(screen.getByRole('button', { name: 'Close history search' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(onAccept).not.toHaveBeenCalled()
  })

  it('keeps the highlighted row in view while stepping', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      const first = renderOverlay(narrowed(items, 'ship'))
      // cursor 0 rendered first
      first.view.rerender(
        <HistorySearchOverlay
          search={searchKey(narrowed(items, 'ship'), { type: 'step-older' }).search}
          onHighlight={() => {}}
          onAccept={() => {}}
          onClose={() => {}}
        />,
      )
      expect(scrollIntoView).toHaveBeenCalled()
    } finally {
      Element.prototype.scrollIntoView = () => {}
    }
  })
})

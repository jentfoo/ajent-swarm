import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { QueuedPrompts } from './QueuedPrompts'
import type { DroppedQueueRow, PendingSubmit } from '../state/eventApplier'
import type { QueueRow } from '../api/types'

// The chip list is a pure projection of reconciled queue state: one ordered
// render under the cap. Every case mounts props directly, no channel involved.

function rows(...texts: string[]): QueueRow[] {
  return texts.map((text, i) => ({ id: `q${i}`, text }))
}

// refused builds one failed optimistic row aged ageMs past its refusal.
function refused(text: string, ageMs = 0): PendingSubmit {
  return { id: `f-${text}`, text, state: 'failed', failedAt: Date.now() - ageMs }
}

function renderChips({
  queuedRows = [],
  pendings = [],
  droppedRows = [],
  onEdit = () => {},
}: {
  queuedRows?: QueueRow[]
  pendings?: PendingSubmit[]
  droppedRows?: DroppedQueueRow[]
  onEdit?: () => void
} = {}) {
  return render(
    <QueuedPrompts
      queuedRows={queuedRows}
      pendings={pendings}
      droppedRows={droppedRows}
      onEdit={onEdit}
    />,
  )
}

describe('QueuedPrompts', () => {
  it('renders nothing without rows', () => {
    renderChips()

    expect(screen.queryByLabelText('Queued prompts')).not.toBeInTheDocument()
  })

  it('caps at four showing the newest end', async () => {
    const onEdit = vi.fn()
    renderChips({ queuedRows: rows('row 0', 'row 1', 'row 2', 'row 3', 'row 4', 'row 5'), onEdit })

    expect(screen.getByText('+2 more')).toBeInTheDocument()
    expect(screen.queryByText('row 0')).not.toBeInTheDocument()
    expect(screen.queryByText('row 1')).not.toBeInTheDocument()
    for (const at of [2, 3, 4, 5]) {
      expect(screen.getByText(`row ${at}`)).toBeInTheDocument()
    }

    // only the newest wire row offers recall-to-edit and it stays visible
    await userEvent.setup().click(screen.getByRole('button', { name: /edit/ }))
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('counts pending and failed rows against the cap', () => {
    renderChips({
      queuedRows: rows('queued one', 'queued two', 'queued three', 'queued four'),
      pendings: [{ id: 'p0', text: 'in flight', state: 'pending' }, refused('was refused')],
    })

    expect(screen.getByText('+2 more')).toBeInTheDocument()
    expect(screen.queryByText('queued one')).not.toBeInTheDocument()
    expect(screen.getByText('queued four')).toBeInTheDocument()
    expect(screen.getByText('in flight')).toBeInTheDocument()
    expect(screen.getByText('was refused')).toBeInTheDocument()
  })

  it('renders dropped rows first under the same cap', () => {
    renderChips({
      queuedRows: rows('live one', 'live two'),
      droppedRows: [
        { id: 'd0', text: 'dropped old', cause: 'interrupt' },
        { id: 'd1', text: 'dropped new', cause: 'recalled' },
        { id: 'd2', text: 'dropped last', cause: 'rewind' },
      ],
    })

    expect(screen.getByText('+1 more')).toBeInTheDocument()
    expect(screen.queryByText('dropped old')).not.toBeInTheDocument()
    expect(screen.getByText('dropped new')).toBeInTheDocument()
    expect(screen.getByText('live two')).toBeInTheDocument()

    // former queue rows read before the live ones
    const dropped = screen.getByText('dropped new').closest('.queue-chip')!
    const live = screen.getByText('live one').closest('.queue-chip')!
    expect(dropped.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps secret rows id only', () => {
    renderChips({ queuedRows: [{ id: 'secret000123456789', text: '' }] })

    expect(screen.getByText('secret prompt secret00…')).toBeInTheDocument()
  })

  it('skips wire-named optimistic rows', () => {
    renderChips({
      queuedRows: [{ id: 'p1', text: 'named row' }],
      pendings: [{ id: 'p1', text: 'named row', state: 'pending' }],
    })

    expect(screen.getAllByText('named row')).toHaveLength(1)
  })

  it('expires a refused chip after its ttl', () => {
    vi.useFakeTimers()
    try {
      renderChips({ queuedRows: rows('live one'), pendings: [refused('was refused')] })
      expect(screen.getByText('was refused')).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(9_000)
      })
      // the refusal leaves on its own and neighbors keep their place
      expect(screen.queryByText('was refused')).not.toBeInTheDocument()
      expect(screen.getByText('live one')).toBeInTheDocument()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips refusals that expired before mount', () => {
    vi.useFakeTimers()
    try {
      renderChips({ pendings: [refused('long gone', 9_000)] })

      expect(screen.queryByText('long gone')).not.toBeInTheDocument()
      // nothing fresh, so no timer runs for an all-stale list either
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('expires refusals independently of each other', () => {
    vi.useFakeTimers()
    try {
      renderChips({ pendings: [refused('stale refusal', 9_000), refused('fresh refusal')] })

      expect(screen.getByText('fresh refusal')).toBeInTheDocument()
      expect(screen.queryByText('stale refusal')).not.toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(9_000)
      })
      expect(screen.queryByText(/refusal/)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

// Refusals announce through one sr-only polite region inside the chip band, so
// a failed submit is heard while ordinary queue chips stay silent. The line
// derives purely from the fresh failures: it changes only when they do.
describe('QueuedPrompts refusal announcements', () => {
  // the one sr-only polite region riding the chip band
  const announcement = () =>
    screen.getByLabelText('Queued prompts').querySelector<HTMLElement>('[aria-live="polite"]')

  it('announces a fresh refusal through a polite live region', () => {
    renderChips({ pendings: [refused('was refused')] })

    expect(announcement()).toHaveAttribute('aria-live', 'polite')
    expect(announcement()).toHaveTextContent('Prompt refused: was refused')
  })

  it('redacts a secret refusal to its id like the chip', () => {
    renderChips({
      pendings: [{ id: 'secret000123456789', text: '', state: 'failed', failedAt: Date.now() }],
    })

    expect(announcement()).toHaveTextContent('Prompt refused: secret prompt secret00…')
  })

  it('counts several fresh refusals without reading each row', () => {
    renderChips({ pendings: [refused('first'), refused('second')] })

    expect(announcement()).toHaveTextContent('2 prompts refused')
  })

  it('stays silent once every refusal expired', () => {
    vi.useFakeTimers()
    try {
      renderChips({ pendings: [refused('was refused')] })
      expect(announcement()).toHaveTextContent(/Prompt refused/)

      act(() => {
        vi.advanceTimersByTime(9_000)
      })
      // the last chip left with it, so the whole band unmounts
      expect(screen.queryByLabelText('Queued prompts')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps quiet while only ordinary queue rows render', () => {
    renderChips({
      queuedRows: rows('queued one'),
      pendings: [{ id: 'p0', text: 'in flight', state: 'pending' }],
    })

    // the region rides the band for later refusals, its line empty
    expect(announcement()).toBeEmptyDOMElement()
  })
})

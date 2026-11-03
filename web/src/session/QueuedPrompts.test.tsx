import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { QueuedPrompts } from './QueuedPrompts'
import type { DroppedQueueRow, PendingSubmit } from '../state/eventApplier'
import type { QueueRow } from '../api/types'

// The chip list is a pure projection of reconciled queue state: one ordered
// render under the cap. Every case mounts props directly; no channel involved.

function rows(...texts: string[]): QueueRow[] {
  return texts.map((text, i) => ({ id: `q${i}`, text }))
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
      pendings: [
        { id: 'p0', text: 'in flight', state: 'pending' },
        { id: 'p1', text: 'was refused', state: 'failed' },
      ],
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
})

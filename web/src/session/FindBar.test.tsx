import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { FindBar } from './FindBar'
import type { TranscriptMatch } from './transcriptSearch'

// The find surface is presentation over the pure machinery: the count line,
// the stepping keys and buttons, the empty state, and the overlay stack
// contract (Escape closes, the opener gets focus back).

const hit: TranscriptMatch = {
  blockId: 'u1',
  blockIdx: 0,
  region: 0,
  at: 9,
  label: 'user',
  snippet: '…find the needle here',
  markAt: 10,
  markEnd: 16,
}

function renderBar(overrides: Partial<Parameters<typeof FindBar>[0]> = {}) {
  const onQuery = vi.fn()
  const onStep = vi.fn()
  const onClose = vi.fn()
  render(
    <FindBar
      query="needle"
      count={2}
      active={0}
      activeMatch={hit}
      onQuery={onQuery}
      onStep={onStep}
      onClose={onClose}
      {...overrides}
    />,
  )
  return { onQuery, onStep, onClose }
}

describe('FindBar readouts', () => {
  it('shows the active index over the total', () => {
    renderBar()
    expect(screen.getByText('1/2')).toBeInTheDocument()
  })

  it('shows the empty-match state', () => {
    renderBar({ count: 0, active: -1, activeMatch: null })
    expect(screen.getByText('no matches')).toBeInTheDocument()
    expect(screen.getByLabelText('Previous match')).toBeDisabled()
    expect(screen.getByLabelText('Next match')).toBeDisabled()
  })

  it('shows no count line while the query is blank', () => {
    renderBar({ query: '', count: 0, active: -1, activeMatch: null })
    expect(screen.queryByText('no matches')).not.toBeInTheDocument()
  })

  it('renders the snippet with the hit marked', () => {
    renderBar()
    expect(screen.getByText('user')).toBeInTheDocument()
    expect(screen.getByText('needle').closest('mark')).not.toBeNull()
  })
})

describe('FindBar controls', () => {
  it('reports edits through onQuery', async () => {
    const user = userEvent.setup()
    const { onQuery } = renderBar()
    await user.type(screen.getByLabelText('Find query'), 'x')
    expect(onQuery).toHaveBeenLastCalledWith('needlex')
  })

  it('steps with the buttons and the Enter keys', async () => {
    const user = userEvent.setup()
    const { onStep } = renderBar()
    await user.click(screen.getByLabelText('Next match'))
    expect(onStep).toHaveBeenLastCalledWith(1)
    await user.click(screen.getByLabelText('Previous match'))
    expect(onStep).toHaveBeenLastCalledWith(-1)

    const box = screen.getByLabelText('Find query')
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: false })
    expect(onStep).toHaveBeenLastCalledWith(1)
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(onStep).toHaveBeenLastCalledWith(-1)
  })

  it('closes through the button and a plain Escape', async () => {
    const user = userEvent.setup()
    const { onClose } = renderBar()
    await user.click(screen.getByLabelText('Close find'))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

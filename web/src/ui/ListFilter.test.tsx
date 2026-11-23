import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ListFilter } from './ListFilter'
import { stubCoarsePointer } from '../test/matchMedia'

// The shared search input heading every operational list: a labeled
// `type="search"` box, Escape clearing a non-empty query before an overlay
// close can claim the press, and the caret waiting for a deliberate tap on
// touch.
describe('ListFilter', () => {
  it('renders a labeled search box', () => {
    render(<ListFilter label="Filter sessions" value="" onChange={() => {}} />)

    const box = screen.getByRole('searchbox', { name: 'Filter sessions' })
    expect(box).toHaveAttribute('type', 'search')
    expect(box).toHaveAttribute('placeholder', 'Filter sessions')
  })

  it('reports edits through onChange', async () => {
    const onChange = vi.fn()
    render(<ListFilter label="Filter sessions" value="" onChange={onChange} />)

    await userEvent.setup().type(screen.getByRole('searchbox'), 'a')
    expect(onChange).toHaveBeenCalledWith('a')
  })

  it('claims escape to clear a non-empty query', () => {
    const onChange = vi.fn()
    render(<ListFilter label="Filter sessions" value="abc" onChange={onChange} />)

    // a claimed press preventDefaults, an overlay close never sees it
    expect(fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })).toBe(false)
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('lets escape fall through on an empty query', () => {
    const onChange = vi.fn()
    render(<ListFilter label="Filter sessions" value="   " onChange={onChange} />)

    expect(fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('takes the caret on mount for a fine pointer', () => {
    render(<ListFilter label="Filter sessions" value="" onChange={() => {}} autoFocus />)

    expect(screen.getByRole('searchbox')).toHaveFocus()
  })

  it('waits for a deliberate tap before touch focus', () => {
    stubCoarsePointer()
    fireEvent.pointerDown(document.body) // the tap that opened this list
    render(<ListFilter label="Filter sessions" value="" onChange={() => {}} autoFocus />)

    expect(screen.getByRole('searchbox')).not.toHaveFocus()
  })

  it('skips focus without autoFocus', () => {
    render(<ListFilter label="Filter sessions" value="" onChange={() => {}} />)

    expect(screen.getByRole('searchbox')).not.toHaveFocus()
  })
})

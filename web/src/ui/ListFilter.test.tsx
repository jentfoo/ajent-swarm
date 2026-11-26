import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ListFilter } from './ListFilter'
import { overlayEnter, overlayLeave } from './overlayStack'
import { stubCoarsePointer } from '../test/matchMedia'

// The shared search input heading every operational list: a labeled
// `type="search"` box under a decorative magnifier, Escape clearing a
// non-empty query before an overlay close can claim the press, the caret
// waiting for a deliberate tap on touch, and the page-level extras: a polite
// result count and the '/' hotkey that stands down inside fields and layers.
describe('ListFilter', () => {
  it('renders a labeled search box', () => {
    render(<ListFilter label="Filter sessions" value="" onChange={() => {}} />)

    const box = screen.getByRole('searchbox', { name: 'Filter sessions' })
    expect(box).toHaveAttribute('type', 'search')
    expect(box).toHaveAttribute('placeholder', 'Filter sessions')
  })

  it('keeps the leading magnifier decorative', () => {
    const { container } = render(
      <ListFilter label="Filter sessions" value="" onChange={() => {}} />,
    )

    const icon = container.querySelector('.list-filter-field svg')
    expect(icon).not.toBeNull()
    // the input's aria-label carries the accessible name, never the glyph
    expect(icon).toHaveAttribute('aria-hidden', 'true')
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

  it('renders the result count as a polite status', () => {
    render(
      <ListFilter label="Filter jobs" value="" onChange={() => {}} resultCount="2 of 5 jobs" />,
    )

    expect(screen.getByText('2 of 5 jobs')).toHaveAttribute('role', 'status')
  })

  it('trails a changed count through the announce debounce', async () => {
    const view = render(
      <ListFilter label="Filter jobs" value="" onChange={() => {}} resultCount="3 of 3 jobs" />,
    )

    view.rerender(
      <ListFilter label="Filter jobs" value="" onChange={() => {}} resultCount="2 of 3 jobs" />,
    )
    // one burst lands as one announcement after the debounce
    await waitFor(() => expect(screen.getByText('2 of 3 jobs')).toBeInTheDocument())
  })

  it('focuses the input on / when hotkey is bound', () => {
    render(<ListFilter label="Filter sessions" value="" onChange={() => {}} hotkey />)

    fireEvent.keyDown(document.body, { key: '/' })

    expect(screen.getByRole('searchbox')).toHaveFocus()
  })

  it.each([
    ['ctrl', { ctrlKey: true }],
    ['meta', { metaKey: true }],
    ['shift', { shiftKey: true }],
  ])('ignores a %s chord on /', (_name, init) => {
    render(<ListFilter label="Filter sessions" value="" onChange={() => {}} hotkey />)

    fireEvent.keyDown(document.body, { key: '/', ...init })

    expect(screen.getByRole('searchbox')).not.toHaveFocus()
  })

  it('keeps an editable target its /', () => {
    render(
      <>
        <input aria-label="other field" />
        <ListFilter label="Filter sessions" value="" onChange={() => {}} hotkey />
      </>,
    )

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'other field' }), { key: '/' })

    expect(screen.getByRole('searchbox')).not.toHaveFocus()
  })

  it('stands down behind an open overlay layer', () => {
    const layer = document.createElement('div')
    overlayEnter(layer)
    render(<ListFilter label="Filter sessions" value="" onChange={() => {}} hotkey />)

    fireEvent.keyDown(document.body, { key: '/' })
    expect(screen.getByRole('searchbox')).not.toHaveFocus()

    overlayLeave(layer)
  })

  it('leaves a press another listener claimed alone', () => {
    render(<ListFilter label="Filter sessions" value="" onChange={() => {}} hotkey />)
    // an earlier bubbling listener on document claims the press first
    const claim = (ev: Event): void => ev.preventDefault()
    document.addEventListener('keydown', claim)

    fireEvent.keyDown(document.body, { key: '/' })
    expect(screen.getByRole('searchbox')).not.toHaveFocus()

    document.removeEventListener('keydown', claim)
  })

  it('binds no hotkey by default', () => {
    render(<ListFilter label="Filter sessions" value="" onChange={() => {}} />)

    fireEvent.keyDown(document.body, { key: '/' })

    expect(screen.getByRole('searchbox')).not.toHaveFocus()
  })
})

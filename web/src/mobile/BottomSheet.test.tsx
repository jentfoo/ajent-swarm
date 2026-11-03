import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BottomSheet } from './BottomSheet'

// The sheet's dismissal contract: the handle drags down past a threshold,
// below it springs back, and the backdrop closes.

function renderSheet(onClose = vi.fn()) {
  render(
    <BottomSheet open onClose={onClose} label="Session switcher">
      <p>rows</p>
    </BottomSheet>,
  )
  const handle = screen.getByRole('button', { name: 'Dismiss Session switcher' })
  return { onClose, handle }
}

function drag(handle: Element, dy: number) {
  fireEvent.pointerDown(handle, { pointerId: 1, clientY: 300 })
  fireEvent.pointerMove(handle, { pointerId: 1, clientY: 300 + dy })
  fireEvent.pointerUp(handle, { pointerId: 1 })
}

describe('BottomSheet', () => {
  beforeEach(() => {
    // jsdom ships no pointer capture; the drag only needs the events
    Element.prototype.setPointerCapture = () => {}
  })
  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, 'setPointerCapture')
  })

  it('renders nothing when closed', () => {
    const { container } = render(
      <BottomSheet open={false} onClose={() => {}} label="Sheet">
        <p>rows</p>
      </BottomSheet>,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('dismisses once the handle drag passes the threshold', () => {
    const { onClose, handle } = renderSheet()
    drag(handle, 96)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('springs back below the threshold', () => {
    const { onClose, handle } = renderSheet()
    drag(handle, 40)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('rows')).toBeInTheDocument()
  })

  it('closes on a backdrop tap', () => {
    const { onClose } = renderSheet()
    fireEvent.click(document.querySelector('.sheet-backdrop')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

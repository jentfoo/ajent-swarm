import { act, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
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
    Reflect.deleteProperty(window, 'visualViewport')
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

  it('closes exactly once per release under StrictMode', () => {
    const onClose = vi.fn()
    render(
      <StrictMode>
        <BottomSheet open onClose={onClose} label="Session switcher">
          <p>rows</p>
        </BottomSheet>
      </StrictMode>,
    )
    const handle = screen.getByRole('button', { name: 'Dismiss Session switcher' })
    drag(handle, 96)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('reopens without a stale drag offset', () => {
    function Sheet({ open, onClose }: { open: boolean; onClose: () => void }) {
      return (
        <BottomSheet open={open} onClose={onClose} label="Session switcher">
          <p>rows</p>
        </BottomSheet>
      )
    }
    const onClose = vi.fn()
    const { rerender } = render(<Sheet open onClose={onClose} />)
    const handle = screen.getByRole('button', { name: 'Dismiss Session switcher' })

    // a partial drag dismissed by the backdrop must not leak into next open
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 300 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 340 })
    fireEvent.click(document.querySelector('.sheet-backdrop')!)
    rerender(<Sheet open={false} onClose={onClose} />)
    rerender(<Sheet open onClose={onClose} />)

    const sheet = document.querySelector('.bottom-sheet') as HTMLElement
    expect(sheet.style.transform).toBe('')
  })

  it('docks above the keyboard through the inset custom property', () => {
    // visualViewport stand-in with a mutable height for the inset hook
    const vv = new EventTarget() as EventTarget & { height: number }
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    vv.height = 800
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv })

    render(
      <BottomSheet open onClose={() => {}} label="Session switcher">
        <input aria-label="Sheet input" />
      </BottomSheet>,
    )
    // an inset means a keyboard, which only exists while text entry holds focus
    act(() => {
      screen.getByRole('textbox', { name: 'Sheet input' }).focus()
    })

    // the backdrop publishes the inset; theme.css shrinks it from the bottom,
    // since ancestor padding cannot move a position:fixed panel
    const backdrop = document.querySelector('.sheet-backdrop') as HTMLElement
    expect(backdrop.style.getPropertyValue('--keyboard-inset')).toBe('0px')

    vv.height = 550
    act(() => {
      vv.dispatchEvent(new Event('resize'))
    })
    expect(backdrop.style.getPropertyValue('--keyboard-inset')).toBe('250px')
  })
})

import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BottomSheet } from './BottomSheet'

// The sheet's dismissal contract: the handle drags down past a threshold,
// below it springs back, a plain tap on the handle or the backdrop closes,
// Escape closes the topmost sheet and returns focus to the opener, and the
// platform back gesture closes it like any overlay layer.

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
  fireEvent.pointerDown(handle, { pointerId: 1, clientX: 20, clientY: 300 })
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 20, clientY: 300 + dy })
  fireEvent.pointerUp(handle, { pointerId: 1, clientX: 20, clientY: 300 + dy })
}

// a consume queued by the previous test's cleanup never navigated in jsdom;
// drain its pending pop event so it cannot swallow this test's own
beforeEach(() => {
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.history.replaceState(null, '', window.location.href)
})

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

  it('dismisses on a plain tap of the handle', () => {
    const { onClose, handle } = renderSheet()
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 20, clientY: 300 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 22, clientY: 302 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('dismisses from the keyboard on the handle', async () => {
    const { onClose, handle } = renderSheet()
    const user = userEvent.setup()
    handle.focus()
    await user.keyboard('{Enter}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('springs back without closing when the system takes the pointer', () => {
    const { onClose, handle } = renderSheet()
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 20, clientY: 300 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 20, clientY: 520 })
    fireEvent.pointerCancel(handle, { pointerId: 1 })
    expect(onClose).not.toHaveBeenCalled()

    // the reset drag offset leaves no stale transform behind
    const sheet = document.querySelector('.bottom-sheet') as HTMLElement
    expect(sheet.style.transform).toBe('')
  })

  it('closes on a backdrop tap', () => {
    const { onClose } = renderSheet()
    fireEvent.click(document.querySelector('.sheet-backdrop')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on escape and restores focus to the opener', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <>
        <button type="button">opener</button>
        <BottomSheet open onClose={onClose} label="Session switcher">
          <p>rows</p>
        </BottomSheet>
      </>,
    )

    await user.click(screen.getByRole('button', { name: 'opener' }))
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'opener' })).toHaveFocus()

    rerender(
      <>
        <button type="button">opener</button>
        <BottomSheet open={false} onClose={onClose} label="Session switcher">
          <p>rows</p>
        </BottomSheet>
      </>,
    )
    window.dispatchEvent(new PopStateEvent('popstate')) // settle the consume
  })

  it('closes only the topmost sheet on escape', async () => {
    const closeRewind = vi.fn()
    const closeSwitcher = vi.fn()
    const user = userEvent.setup()
    render(
      <>
        <BottomSheet open onClose={closeRewind} label="Rewind">
          <p>rewind rows</p>
        </BottomSheet>
        <BottomSheet open onClose={closeSwitcher} label="Session switcher">
          <p>switcher rows</p>
        </BottomSheet>
      </>,
    )

    await user.keyboard('{Escape}')
    expect(closeSwitcher).toHaveBeenCalledTimes(1)
    expect(closeRewind).not.toHaveBeenCalled()
    window.dispatchEvent(new PopStateEvent('popstate'))
    window.dispatchEvent(new PopStateEvent('popstate'))
  })

  it('closes on a pop event, the platform back gesture', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const onClose = vi.fn()
    const { rerender } = render(
      <BottomSheet open onClose={onClose} label="Session switcher">
        <p>rows</p>
      </BottomSheet>,
    )

    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(onClose).toHaveBeenCalledTimes(1)

    // the state change the close drives unmounts the sheet and consumes its
    // own entry, exactly like an in-app close does
    rerender(
      <BottomSheet open={false} onClose={onClose} label="Session switcher">
        <p>rows</p>
      </BottomSheet>,
    )
    expect(back).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new PopStateEvent('popstate')) // settle the consume
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

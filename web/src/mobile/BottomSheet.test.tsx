import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode, useState } from 'react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BottomSheet } from './BottomSheet'

// The sheet's dismissal contract: the handle drags down past a threshold,
// below it springs back, a plain tap on the handle or the backdrop closes,
// Escape closes the topmost sheet and returns focus to the opener, and the
// platform back gesture closes it like any overlay layer. Focus follows the
// modal contract: opening takes it into the panel, Tab cycles inside, and
// every dismissal path hands it back to what opened the sheet.

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

// opens the sheet from a real trigger, so focus starts outside it and every
// dismissal path can be checked against the element that opened it
function FocusHarness({ children }: { children: ReactElement }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        opener
      </button>
      {open && (
        <BottomSheet open onClose={() => setOpen(false)} label="Session switcher">
          {children}
        </BottomSheet>
      )}
    </>
  )
}

const opener = () => screen.getByRole('button', { name: 'opener' })
const sheetDialog = () => screen.getByRole('dialog', { name: 'Session switcher' })

// a consume queued by the previous test's cleanup never navigated in jsdom
// drain its pending pop event so it cannot swallow this test's own
beforeEach(() => {
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.history.replaceState(null, '', window.location.href)
})

describe('BottomSheet', () => {
  beforeEach(() => {
    // jsdom ships no pointer capture, the drag only needs the events
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

  it('ignores a second pointer pressing the handle mid-drag', () => {
    const { onClose, handle } = renderSheet()
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 20, clientY: 300 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 20, clientY: 400 })

    // finger two lands on the handle and slides: it neither steers the sheet…
    fireEvent.pointerDown(handle, { pointerId: 2, clientX: 100, clientY: 350 })
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 100, clientY: 620 })
    const sheet = document.querySelector('.bottom-sheet') as HTMLElement
    expect(sheet.style.transform).toBe('translateY(100px)')

    // …nor dismisses it, its near-stationary release would read as a tap
    fireEvent.pointerUp(handle, { pointerId: 2, clientX: 102, clientY: 352 })
    expect(onClose).not.toHaveBeenCalled()

    // finger one still owns the drag and its past-threshold release closes it
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 20, clientY: 500 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 20, clientY: 500 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the drag when only the second finger is cancelled', () => {
    const { onClose, handle } = renderSheet()
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 20, clientY: 300 })
    fireEvent.pointerDown(handle, { pointerId: 2, clientX: 100, clientY: 310 })

    // the system reclaims finger two only: finger one keeps dragging
    fireEvent.pointerCancel(handle, { pointerId: 2 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 20, clientY: 420 })
    const sheet = document.querySelector('.bottom-sheet') as HTMLElement
    expect(sheet.style.transform).toBe('translateY(120px)')

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 20, clientY: 420 })
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

  it('opens focused and restores the opener on escape', async () => {
    const user = userEvent.setup()
    render(
      <FocusHarness>
        <button type="button">first</button>
      </FocusHarness>,
    )

    await user.click(opener())
    expect(sheetDialog()).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener()).toHaveFocus()
  })

  it('traps tab and shift-tab inside the sheet', async () => {
    const user = userEvent.setup()
    render(
      <FocusHarness>
        <>
          <button type="button">first</button>
          <button type="button">second</button>
        </>
      </FocusHarness>,
    )

    await user.click(opener())
    const handle = screen.getByRole('button', { name: 'Dismiss Session switcher' })
    const first = screen.getByRole('button', { name: 'first' })
    const second = screen.getByRole('button', { name: 'second' })

    // from the panel, Tab enters at the handle and then walks the content
    fireEvent.keyDown(sheetDialog(), { key: 'Tab' })
    expect(handle).toHaveFocus()
    fireEvent.keyDown(handle, { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'Tab' })
    expect(second).toHaveFocus()

    // both ends wrap, so neither press can drop focus behind the backdrop
    fireEvent.keyDown(second, { key: 'Tab' })
    expect(handle).toHaveFocus()
    fireEvent.keyDown(handle, { key: 'Tab', shiftKey: true })
    expect(second).toHaveFocus()
  })

  it('keeps autofocus content in charge and still restores the opener', async () => {
    const user = userEvent.setup()
    render(
      <FocusHarness>
        <input autoFocus aria-label="Title" />
      </FocusHarness>,
    )

    await user.click(opener())
    expect(screen.getByLabelText('Title')).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(opener()).toHaveFocus()
  })

  it('restores the opener after a drag dismiss', async () => {
    const user = userEvent.setup()
    render(
      <FocusHarness>
        <p>rows</p>
      </FocusHarness>,
    )

    await user.click(opener())
    drag(screen.getByRole('button', { name: 'Dismiss Session switcher' }), 96)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener()).toHaveFocus()
  })

  it('recaptures focus that escapes while topmost', async () => {
    const user = userEvent.setup()
    render(
      <FocusHarness>
        <p>rows</p>
      </FocusHarness>,
    )

    await user.click(opener())
    opener().focus()
    expect(sheetDialog()).toHaveFocus()
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
})

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BottomSheet } from './BottomSheet'
import { PushedScreen } from './PushedScreen'

// The pushed full-screen layer contract: a Back header, Escape closing
// through the shared overlay stack, the platform back gesture (a pop event)
// closing it like any other layer, and the focus contract shared with
// ModalShell and BottomSheet: opening takes focus into the panel, Tab cycles
// inside it, stray focus is recaptured, and closing restores the opener.

// a consume queued by the previous test's cleanup never navigated in jsdom
// drain its pending pop event so it cannot swallow this test's own
beforeEach(() => {
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.history.replaceState(null, '', window.location.href)
})

// opens the screen from a real trigger, so focus starts outside it and the
// open and close paths answer to the element that opened it
function FocusHarness({
  onClose,
  children,
}: {
  onClose?: () => void
  children: ReactElement
}): ReactElement {
  const [open, setOpen] = useState(false)
  const close = () => {
    onClose?.()
    setOpen(false)
  }
  return (
    <>
      <button type="button">background</button>
      <button type="button" onClick={() => setOpen(true)}>
        opener
      </button>
      {open && (
        <PushedScreen title="Tools" onClose={close}>
          {children}
        </PushedScreen>
      )}
    </>
  )
}

// the screen opens from the opener, the sheet from inside the screen, so the
// sheet stacks above and hands focus back into the screen when it closes
function StackedHarness(): ReactElement {
  const [screenOpen, setScreenOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setScreenOpen(true)}>
        opener
      </button>
      {screenOpen && (
        <PushedScreen title="Tools" onClose={() => setScreenOpen(false)}>
          <button type="button" onClick={() => setSheetOpen(true)}>
            open sheet
          </button>
        </PushedScreen>
      )}
      {sheetOpen && (
        <BottomSheet open onClose={() => setSheetOpen(false)} label="Picker">
          <button type="button">sheet control</button>
        </BottomSheet>
      )}
    </>
  )
}

const opener = () => screen.getByRole('button', { name: 'opener' })
const background = () => screen.getByRole('button', { name: 'background' })
const screenDialog = () => screen.getByRole('dialog', { name: 'Tools' })

describe('PushedScreen', () => {
  it('renders the back header beside the title', () => {
    render(
      <PushedScreen title="Tools" onClose={() => {}}>
        <p>body</p>
      </PushedScreen>,
    )
    expect(screen.getByRole('dialog', { name: 'Tools' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '← Back' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Tools' })).toBeInTheDocument()
  })

  it('marks the panel an aria modal layer', () => {
    render(
      <PushedScreen title="Tools" onClose={() => {}}>
        <p>body</p>
      </PushedScreen>,
    )
    expect(screenDialog()).toHaveAttribute('aria-modal', 'true')
  })

  it('closes from the back button', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <PushedScreen title="Tools" onClose={onClose}>
        <p>body</p>
      </PushedScreen>,
    )

    await user.click(screen.getByRole('button', { name: '← Back' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on escape and restores focus to the opener', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <FocusHarness onClose={onClose}>
        <p>body</p>
      </FocusHarness>,
    )

    await user.click(opener())
    expect(screenDialog()).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener()).toHaveFocus()
  })

  it('takes focus on open and restores the opener on back', async () => {
    const user = userEvent.setup()
    render(
      <FocusHarness>
        <p>body</p>
      </FocusHarness>,
    )

    await user.click(opener())
    expect(screenDialog()).toHaveFocus()

    await user.click(screen.getByRole('button', { name: '← Back' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener()).toHaveFocus()
  })

  it('keeps content autofocus in charge', async () => {
    const user = userEvent.setup()
    render(
      <FocusHarness>
        <input autoFocus aria-label="Title" />
      </FocusHarness>,
    )

    await user.click(opener())
    expect(screen.getByLabelText('Title')).toHaveFocus()
  })

  it('traps tab inside the panel', async () => {
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
    const back = screen.getByRole('button', { name: '← Back' })
    const first = screen.getByRole('button', { name: 'first' })
    const second = screen.getByRole('button', { name: 'second' })

    // from the panel, Tab enters through the Back header and walks the content
    fireEvent.keyDown(screenDialog(), { key: 'Tab' })
    expect(back).toHaveFocus()
    fireEvent.keyDown(back, { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'Tab' })
    expect(second).toHaveFocus()

    // both ends wrap, so neither press can drop focus behind the layer
    fireEvent.keyDown(second, { key: 'Tab' })
    expect(back).toHaveFocus()
    fireEvent.keyDown(back, { key: 'Tab', shiftKey: true })
    expect(second).toHaveFocus()
  })

  it('recaptures stray focus while topmost', async () => {
    const user = userEvent.setup()
    render(
      <FocusHarness>
        <p>body</p>
      </FocusHarness>,
    )

    await user.click(opener())
    background().focus()
    expect(screenDialog()).toHaveFocus()
  })

  it('stands down beneath a stacked sheet', async () => {
    const user = userEvent.setup()
    render(<StackedHarness />)

    await user.click(opener())
    expect(screenDialog()).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'open sheet' }))

    // the sheet owns the trap while topmost: its handle answers Tab, the
    // screen beneath never steals the press or the caret back
    fireEvent.keyDown(window, { key: 'Tab' })
    const handle = screen.getByRole('button', { name: 'Dismiss Picker' })
    expect(handle).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(screen.getByRole('button', { name: 'sheet control' })).toHaveFocus()

    // closing the sheet hands the caret back into the screen, whose trap
    // owns the presses again: Tab wraps from the restored control to Back
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Picker' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'open sheet' })).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(screen.getByRole('button', { name: '← Back' })).toHaveFocus()
  })

  it('closes on a pop event, the platform back gesture', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const onClose = vi.fn()
    const { rerender } = render(
      <PushedScreen title="Tools" onClose={onClose}>
        <p>body</p>
      </PushedScreen>,
    )

    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(onClose).toHaveBeenCalledTimes(1)

    // the state change the close drives unmounts the layer and consumes its
    // own entry, exactly like an in-app close does
    rerender(<></>)
    expect(back).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new PopStateEvent('popstate')) // settle the consume
  })
})

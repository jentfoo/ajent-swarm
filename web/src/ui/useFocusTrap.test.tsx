import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'

import { useOverlayDismiss } from './overlayStack'
import { useFocusTrap } from './useFocusTrap'

// The one focus trap behind ModalShell, BottomSheet and the pushed screens:
// opening takes focus into the panel, plain Tab presses cycle inside while
// the layer is topmost, chords and claimed presses stay with the platform,
// and focus that escapes is pulled back. Escape and the restore on close
// belong to useOverlayDismiss, which every layer here runs beside the trap.

function TrapLayer({
  label,
  onClose,
  children,
}: {
  label: string
  onClose?: () => void
  children?: ReactElement
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useOverlayDismiss(ref, onClose ?? (() => {}))
  useFocusTrap(ref)
  return (
    <div ref={ref} role="dialog" aria-label={label} tabIndex={-1}>
      {children ?? <button type="button">{label} control</button>}
    </div>
  )
}

// opens the layer from a real trigger, so focus starts outside it and the
// open and close paths answer to the element that opened it
function TrapHarness({ children }: { children?: ReactElement }): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button">background</button>
      <button type="button" onClick={() => setOpen(true)}>
        opener
      </button>
      {open && (
        <TrapLayer label="Panel" onClose={() => setOpen(false)}>
          {children}
        </TrapLayer>
      )}
    </>
  )
}

function StackedHarness(): ReactElement {
  const [top, setTop] = useState(true)
  return (
    <>
      <TrapLayer label="Beneath">
        <button type="button">beneath control</button>
      </TrapLayer>
      {top && (
        <TrapLayer label="Top" onClose={() => setTop(false)}>
          <button type="button">top control</button>
        </TrapLayer>
      )}
    </>
  )
}

const opener = () => screen.getByRole('button', { name: 'opener' })
const background = () => screen.getByRole('button', { name: 'background' })
const panel = () => screen.getByRole('dialog', { name: 'Panel' })

describe('useFocusTrap', () => {
  it('takes focus on open and restores the opener on close', async () => {
    const user = userEvent.setup()
    render(<TrapHarness />)

    await user.click(opener())
    expect(panel()).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener()).toHaveFocus()
  })

  it('keeps content autofocus in charge', async () => {
    const user = userEvent.setup()
    render(
      <TrapHarness>
        <input autoFocus aria-label="Title" />
      </TrapHarness>,
    )

    await user.click(opener())
    expect(screen.getByLabelText('Title')).toHaveFocus()
  })

  it('cycles tab inside the panel and wraps both ends', async () => {
    const user = userEvent.setup()
    render(
      <TrapHarness>
        <>
          <button type="button">first</button>
          <button type="button">second</button>
        </>
      </TrapHarness>,
    )

    await user.click(opener())
    const first = screen.getByRole('button', { name: 'first' })
    const second = screen.getByRole('button', { name: 'second' })

    // from the panel, Tab enters through the first control
    fireEvent.keyDown(panel(), { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'Tab' })
    expect(second).toHaveFocus()

    // both ends wrap, so neither press can drop focus behind the layer
    fireEvent.keyDown(second, { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(second).toHaveFocus()
  })

  it('leaves chorded tabs to the platform', async () => {
    const user = userEvent.setup()
    render(<TrapHarness />)

    await user.click(opener())
    fireEvent.keyDown(panel(), { key: 'Tab', ctrlKey: true })
    fireEvent.keyDown(panel(), { key: 'Tab', metaKey: true })
    fireEvent.keyDown(panel(), { key: 'Tab', altKey: true })
    expect(panel()).toHaveFocus()
  })

  it('leaves a tab claimed elsewhere alone', async () => {
    const user = userEvent.setup()
    // registered before the layer, so it answers ahead of the trap
    const claim = (ev: KeyboardEvent) => ev.preventDefault()
    window.addEventListener('keydown', claim, { once: true })
    render(<TrapHarness />)

    await user.click(opener())
    fireEvent.keyDown(panel(), { key: 'Tab' })
    expect(panel()).toHaveFocus()
  })

  it('recaptures focus that escapes to the background', async () => {
    const user = userEvent.setup()
    render(<TrapHarness />)

    await user.click(opener())
    background().focus()
    expect(panel()).toHaveFocus()
  })

  it('answers only while topmost of stacked layers', async () => {
    const user = userEvent.setup()
    render(<StackedHarness />)

    // both layers mounted in one commit: opening focus landed in the top one,
    // which only holds because registration precedes the focus move
    expect(screen.getByRole('dialog', { name: 'Top' })).toHaveFocus()

    // the top layer owns the trap, Tab never reaches the beneath controls
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(screen.getByRole('button', { name: 'top control' })).toHaveFocus()

    // closing it hands the trap back down the stack
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Top' })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(screen.getByRole('button', { name: 'beneath control' })).toHaveFocus()
  })

  it('stops trapping once unmounted', async () => {
    const user = userEvent.setup()
    render(<TrapHarness />)

    await user.click(opener())
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // no listener survives the layer: focus stays where it lands
    background().focus()
    expect(background()).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(background()).toHaveFocus()
  })
})

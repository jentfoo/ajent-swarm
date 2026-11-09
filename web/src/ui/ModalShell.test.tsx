import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ModalShell } from './ModalShell'

// One shell for every centered modal: a labelled aria-modal card over a
// backdrop where Escape and a backdrop click close but inner clicks stay,
// Tab cycles inside the card, stray focus is recaptured while open, and
// closing restores focus to the element focused before opening.

function Harness({
  label = 'Test dialog',
  className,
  showClose,
}: {
  label?: string
  className?: string
  showClose?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      {open && (
        <ModalShell
          label={label}
          className={className}
          showClose={showClose}
          onClose={() => setOpen(false)}
        >
          <button type="button">first</button>
          <button type="button">second</button>
        </ModalShell>
      )}
    </>
  )
}

function AutofocusHarness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      {open && (
        <ModalShell label="Test dialog" onClose={() => setOpen(false)}>
          <input autoFocus aria-label="Title" />
        </ModalShell>
      )}
    </>
  )
}

function StackedHarness() {
  const [outer, setOuter] = useState(false)
  const [inner, setInner] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOuter(true)}>
        open outer
      </button>
      {outer && (
        <ModalShell label="Outer" onClose={() => setOuter(false)}>
          <button type="button" onClick={() => setInner(true)}>
            open inner
          </button>
        </ModalShell>
      )}
      {inner && (
        <ModalShell label="Inner" onClose={() => setInner(false)}>
          <button type="button">inner control</button>
        </ModalShell>
      )}
    </>
  )
}

function OutsideHarness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      {open && (
        <ModalShell label="Test dialog" onClose={() => setOpen(false)}>
          <p>body</p>
        </ModalShell>
      )}
      <button type="button">outside</button>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
    </>
  )
}

// Noop closers keep every shell mounted, so the delegate test only needs to
// observe stack order.
function KeyedStack({ onKey }: { onKey: (ev: KeyboardEvent) => void }) {
  const [inner, setInner] = useState(false)
  return (
    <>
      <ModalShell label="Outer" onKey={onKey} onClose={() => {}}>
        <button type="button" onClick={() => setInner(true)}>
          open inner
        </button>
      </ModalShell>
      {inner && (
        <ModalShell label="Inner" onClose={() => {}}>
          <p>inner body</p>
        </ModalShell>
      )}
    </>
  )
}

// GuardedHarness opts every shell into the discard guard; the harness stays
// mounted so tests can observe what a refused close leaves behind.
function GuardedHarness({ dirty, onClose }: { dirty?: boolean; onClose: () => void }) {
  return (
    <ModalShell label="Test dialog" showClose dirty={dirty} onClose={onClose}>
      <button type="button">first</button>
    </ModalShell>
  )
}

const openTrigger = () => screen.getByRole('button', { name: 'open' })
const dialog = () => screen.getByRole('dialog', { name: 'Test dialog' })

describe('ModalShell', () => {
  it('renders a labelled aria modal over the backdrop', async () => {
    const user = userEvent.setup()
    render(<Harness className="rename-modal" />)

    await user.click(openTrigger())
    expect(dialog()).toHaveAttribute('aria-modal', 'true')
    expect(document.querySelector('.modal-backdrop')).toContainElement(dialog())
    expect(dialog()).toHaveClass('card modal rename-modal')
  })

  it('closes on escape and backdrop click, not inner clicks', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(openTrigger())
    fireEvent.click(dialog())
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(openTrigger())
    fireEvent.click(document.querySelector('.modal-backdrop')!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('ignores modified escapes', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(openTrigger())
    fireEvent.keyDown(dialog(), { key: 'Escape', ctrlKey: true })
    fireEvent.keyDown(dialog(), { key: 'Escape', metaKey: true })
    fireEvent.keyDown(dialog(), { key: 'Escape', altKey: true })
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    // the plain press still closes
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('delegates unclaimed keys to onKey only while topmost', async () => {
    const user = userEvent.setup()
    const onKey = vi.fn()
    render(<KeyedStack onKey={onKey} />)
    const outer = screen.getByRole('dialog', { name: 'Outer' })

    fireEvent.keyDown(outer, { key: 'x' })
    expect(onKey).toHaveBeenCalledOnce()

    // keys the shell owns itself never reach the delegate
    fireEvent.keyDown(outer, { key: 'Escape' })
    fireEvent.keyDown(outer, { key: 'Tab' })
    expect(onKey).toHaveBeenCalledOnce()

    // a platform chord is never the layer's either
    fireEvent.keyDown(outer, { key: 'x', ctrlKey: true })
    expect(onKey).toHaveBeenCalledOnce()

    // a layer stacked above takes the keys, exactly like Escape
    await user.click(screen.getByRole('button', { name: 'open inner' }))
    fireEvent.keyDown(window, { key: 'x' })
    expect(onKey).toHaveBeenCalledOnce()
  })

  it('takes focus on open and restores it after close', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(openTrigger())
    expect(dialog()).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(openTrigger()).toHaveFocus()
  })

  it('traps tab and shift-tab inside the card', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(openTrigger())
    fireEvent.keyDown(dialog(), { key: 'Tab' })
    const first = screen.getByRole('button', { name: 'first' })
    expect(first).toHaveFocus()

    const second = screen.getByRole('button', { name: 'second' })
    fireEvent.keyDown(first, { key: 'Tab' })
    expect(second).toHaveFocus()

    // both ends wrap, so neither press can drop focus behind the backdrop
    fireEvent.keyDown(second, { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(second).toHaveFocus()
  })

  it('keeps content autofocus in charge and still restores the trigger', async () => {
    const user = userEvent.setup()
    render(<AutofocusHarness />)

    await user.click(openTrigger())
    expect(screen.getByLabelText('Title')).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(openTrigger()).toHaveFocus()
  })

  it('answers only the topmost of stacked shells', async () => {
    const user = userEvent.setup()
    render(<StackedHarness />)

    await user.click(screen.getByRole('button', { name: 'open outer' }))
    await user.click(await screen.findByRole('button', { name: 'open inner' }))

    // Escape unwinds one shell at a time, topmost first
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Inner' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Outer' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('recaptures focus that escapes to the background', async () => {
    const user = userEvent.setup()
    render(<OutsideHarness />)

    await user.click(openTrigger())
    screen.getByRole('button', { name: 'outside' }).focus()
    expect(dialog()).toHaveFocus()
  })

  it('shows the corner close button only when asked', async () => {
    const user = userEvent.setup()
    const plain = render(<Harness />)
    await user.click(openTrigger())
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
    plain.unmount()

    render(<Harness showClose />)
    await user.click(openTrigger())
    const close = screen.getByRole('button', { name: 'Close' })
    // rides the dialog card, so a tap never reads as a backdrop click
    expect(dialog()).toContainElement(close)
    await user.click(close)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('asks before a guarded close and stays mounted on cancel', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<GuardedHarness dirty onClose={onClose} />)

    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Discard changes?' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).not.toBeInTheDocument()
    expect(dialog()).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes a guarded dialog only through its confirm', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<GuardedHarness dirty onClose={onClose} />)

    // the backdrop and the corner × both land on the question, not the close
    fireEvent.click(document.querySelector('.modal-backdrop')!)
    expect(screen.getByRole('dialog', { name: 'Discard changes?' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Keep editing' }))

    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Discard changes?' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('routes browser back through the guard and then the question', async () => {
    const onClose = vi.fn()
    render(<GuardedHarness dirty onClose={onClose} />)

    // a pop closes the topmost layer, here the dialog's own shield, which asks
    // instead of discarding
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Discard changes?' })).toBeInTheDocument()

    // a second back pops the confirm's own layer, cancelling it, not the dialog
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).not.toBeInTheDocument()
    expect(dialog()).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('leaves history untouched on escape closes', async () => {
    const user = userEvent.setup()
    const back = vi.spyOn(window.history, 'back')
    const onClose = vi.fn()
    render(<GuardedHarness dirty onClose={onClose} />)

    // a keypress never moves history, only a platform back already has, so the
    // guard's own entry stays current beneath the question
    await user.keyboard('{Escape}')
    expect(back).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Discard changes?' })).toBeInTheDocument()

    // dismissing the question steps back over its own entry and nothing else
    await user.click(screen.getByRole('button', { name: 'Keep editing' }))
    await vi.waitFor(() => expect(back).toHaveBeenCalledTimes(1))
    expect(dialog()).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    back.mockRestore()
  })

  it('closes directly while the guard holds nothing dirty', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<GuardedHarness dirty={false} onClose={onClose} />)

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).not.toBeInTheDocument()
  })
})

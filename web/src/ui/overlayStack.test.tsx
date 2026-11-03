import { useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { MenuPopover } from './MenuPopover'
import { ModalShell } from './ModalShell'
import { overlayOpen, useOverlayDismiss } from './overlayStack'

// One shared layer order behind every overlay kind: exactly the topmost layer
// answers Escape across shells, popovers, sheets and pushed screens, a press
// claimed elsewhere is left alone, and closing hands focus back to the opener.

function DismissLayer({ label, onClose }: { label: string; onClose: () => void }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useOverlayDismiss(ref, onClose)
  return (
    <div ref={ref} data-testid={label}>
      {label}
    </div>
  )
}

function PopoverHarness(): ReactElement {
  const [open, setOpen] = useState(true)
  const anchorRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={anchorRef} type="button" onClick={() => setOpen(false)}>
        trigger
      </button>
      {open && (
        <MenuPopover anchorRef={anchorRef} role="menu" onClose={() => setOpen(false)}>
          <p>menu body</p>
        </MenuPopover>
      )}
    </>
  )
}

function ModalHarness(): ReactElement {
  const [open, setOpen] = useState(true)
  return open ? (
    <ModalShell label="Modal" onClose={() => setOpen(false)}>
      <p>modal body</p>
    </ModalShell>
  ) : (
    <button type="button">modal closed</button>
  )
}

function StackHarness(): ReactElement {
  const [layer, setLayer] = useState(true)
  return (
    <>
      <ModalHarness />
      <PopoverHarness />
      {layer ? (
        <DismissLayer label="sheet" onClose={() => setLayer(false)} />
      ) : (
        <button type="button">sheet closed</button>
      )}
    </>
  )
}

describe('overlayStack', () => {
  it('escape unwinds one layer at a time across overlay kinds', async () => {
    const user = userEvent.setup()
    render(<StackHarness />)
    expect(overlayOpen()).toBe(true)

    // mount order is layer order: the sheet answers first, then the popover,
    // then the modal, and one press never closes two at once
    await user.keyboard('{Escape}')
    expect(screen.getByText('sheet closed')).toBeInTheDocument()
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Modal' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Modal' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(overlayOpen()).toBe(false)
  })

  it('leaves an escape claimed elsewhere alone', () => {
    const close = vi.fn()
    const claim = (ev: KeyboardEvent) => ev.preventDefault()
    document.addEventListener('keydown', claim, { once: true })
    render(<DismissLayer label="sheet" onClose={close} />)

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(close).not.toHaveBeenCalled()
  })

  it('restores focus to the opener when the layer closes', async () => {
    const user = userEvent.setup()
    function Harness(): ReactElement {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open
          </button>
          {open && <DismissLayer label="sheet" onClose={() => setOpen(false)} />}
        </>
      )
    }
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'open' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('sheet')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'open' })).toHaveFocus()
  })
})

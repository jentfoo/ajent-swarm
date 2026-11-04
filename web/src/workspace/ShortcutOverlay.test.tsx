import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ShortcutOverlay } from './ShortcutOverlay'
import { useWorkspaceKeys } from './keys'

// The overlay is modal to workspace shortcuts: keys.ts suppresses its
// bindings while this is mounted, and the overlay alone answers Escape and ?

describe('ShortcutOverlay', () => {
  it('lists the bindings for its mode', () => {
    const { unmount } = render(<ShortcutOverlay mode="inbox" onClose={() => {}} />)
    expect(screen.getByText('j / k')).toBeInTheDocument()
    expect(screen.queryByText('Mod+\\')).not.toBeInTheDocument()

    unmount()
    render(<ShortcutOverlay mode="tile" onClose={() => {}} />)
    expect(screen.getByText('Mod+Shift+\\')).toBeInTheDocument()
  })

  it('closes on Escape, ? and a click outside', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ShortcutOverlay mode="inbox" onClose={onClose} />)

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()

    await user.keyboard('?')
    expect(onClose).toHaveBeenCalledTimes(2)

    fireEvent.click(document.querySelector('.modal-backdrop')!)
    expect(onClose).toHaveBeenCalledTimes(3)

    // clicks inside the card leave it open
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('stands above workspace bindings until it closes', async () => {
    const user = userEvent.setup()
    const onNext = vi.fn()

    function Page() {
      const [open, setOpen] = useState(true)
      useWorkspaceKeys({ onNext })
      if (!open) return null
      return <ShortcutOverlay mode="inbox" onClose={() => setOpen(false)} />
    }
    render(<Page />)

    // j would move the queue cursor behind the overlay; it must not fire
    await user.keyboard('j')
    expect(onNext).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()

    // Escape closes through the overlay's own handling, then bindings return
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument()
    await user.keyboard('j')
    expect(onNext).toHaveBeenCalledOnce()
  })
})

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ShortcutOverlay } from './ShortcutOverlay'

// The overlay is modal to workspace shortcuts: keys.ts suppresses its
// bindings while this is mounted, and the overlay alone answers Escape and ?

describe('ShortcutOverlay', () => {
  it('closes on Escape, ? and a click outside', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ShortcutOverlay mode="focused" onClose={onClose} />)

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
})

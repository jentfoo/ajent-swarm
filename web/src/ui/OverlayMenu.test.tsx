import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OverlayMenu } from './OverlayMenu'

// The shared touch-menu popover: MenuPopover owns placement and dismissal,
// this file pins the layer glue, platform back peeling the menu alone.

// MenuHost stands in for a chip or header trigger mounting its menu while open,
// the one contract every caller shares.
function MenuHost(): ReactElement {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        open
      </button>
      {open && (
        <OverlayMenu anchorRef={triggerRef} onClose={() => setOpen(false)}>
          <button type="button" role="menuitem" onClick={() => setOpen(false)}>
            pick
          </button>
        </OverlayMenu>
      )}
    </>
  )
}

describe('OverlayMenu', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens as a menu off its trigger', async () => {
    const user = userEvent.setup()
    render(<MenuHost />)

    await user.click(screen.getByRole('button', { name: 'open' }))
    expect(await screen.findByRole('menu')).toBeInTheDocument()
  })

  it('dismisses on an outside tap', async () => {
    const user = userEvent.setup()
    render(<MenuHost />)
    await user.click(screen.getByRole('button', { name: 'open' }))
    expect(await screen.findByRole('menu')).toBeInTheDocument()

    fireEvent.pointerDown(document.body) // anywhere outside the trigger and menu
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('dismisses on the platform back gesture', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const user = userEvent.setup()
    render(<MenuHost />)
    await user.click(screen.getByRole('button', { name: 'open' }))
    expect(await screen.findByRole('menu')).toBeInTheDocument()

    // back peels the menu alone, and the unmount consumes the history entry
    // it opened
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'open' })).toBeEnabled()
    expect(back).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new PopStateEvent('popstate')) // settle the consume
  })
})

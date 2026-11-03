import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PushedScreen } from './PushedScreen'

// The pushed full-screen layer contract: a Back header, Escape closing
// through the shared overlay stack, focus returning to the opener, and the
// platform back gesture (a pop event) closing it like any other layer.

// a consume queued by the previous test's cleanup never navigated in jsdom;
// drain its pending pop event so it cannot swallow this test's own
beforeEach(() => {
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.history.replaceState(null, '', window.location.href)
})

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
      <>
        <button type="button">opener</button>
        <PushedScreen title="Tools" onClose={onClose}>
          <p>body</p>
        </PushedScreen>
      </>,
    )

    await user.click(screen.getByRole('button', { name: 'opener' }))
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'opener' })).toHaveFocus()
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

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ModalShell } from '../ui/ModalShell'
import { ShortcutOverlay } from './ShortcutOverlay'

// The overlay is modal to workspace shortcuts: ModalShell holds the
// workspace's bindings down while this is mounted, and ? rides the shell's
// listener, so it answers only while the overlay is the topmost layer and
// never as a chord or a press claimed elsewhere.

describe('ShortcutOverlay', () => {
  it('closes on escape, ? and a click outside', async () => {
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

  it('ignores modified ? presses', () => {
    const onClose = vi.fn()
    render(<ShortcutOverlay mode="focused" onClose={onClose} />)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: '?', ctrlKey: true })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: '?', metaKey: true })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: '?', altKey: true })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('leaves a ? claimed elsewhere alone', () => {
    const onClose = vi.fn()
    // registered before render, so it answers before the shell's own listener
    const claim = (ev: KeyboardEvent) => ev.preventDefault()
    window.addEventListener('keydown', claim, { once: true })
    render(<ShortcutOverlay mode="focused" onClose={onClose} />)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: '?' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('rests ? while another layer is on top', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <>
        <ShortcutOverlay mode="focused" onClose={onClose} />
        <ModalShell label="Upper" onClose={() => {}}>
          <p>upper layer</p>
        </ModalShell>
      </>,
    )

    await user.keyboard('?')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('documents the composer bindings', () => {
    render(<ShortcutOverlay mode="tile" onClose={() => {}} />)

    // both modes list the composer bindings: Ctrl+R, the post-accept arrow
    // browse, and the queued-prompt recall gesture
    expect(screen.getByText('Ctrl+R')).toBeInTheDocument()
    expect(screen.getByText('↑ / ↓')).toBeInTheDocument()
    expect(screen.getByText('Alt+↑')).toBeInTheDocument()
  })

  it('documents the rewind gesture in both modes', () => {
    for (const mode of ['focused', 'tile'] as const) {
      const view = render(<ShortcutOverlay mode={mode} onClose={() => {}} />)
      expect(screen.getByText('Esc ×2')).toBeInTheDocument()
      view.unmount()
    }
  })
})

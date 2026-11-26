import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Toasts } from './Toasts'
import type { ToastView } from './useToasts'

// The shared stack both session chromes render: rows in arrival order, each
// its own live region by severity, a named close control per row, and a
// mouse-or-focus hold over the expiry, fully driven by the list useToasts
// hands over.

let nextID = 0

function toast(text: string, level: ToastView['level'] = 'info'): ToastView {
  return { id: ++nextID, text, level }
}

function renderToasts(toasts: ToastView[]) {
  const onDismiss = vi.fn()
  const onPause = vi.fn()
  const onResume = vi.fn()
  const view = render(
    <Toasts toasts={toasts} onDismiss={onDismiss} onPause={onPause} onResume={onResume} />,
  )
  return { ...view, onDismiss, onPause, onResume }
}

describe('Toasts', () => {
  it('renders rows in arrival order with their level', () => {
    const { container } = renderToasts([toast('copied'), toast('seat held', 'error')])

    const stack = container.querySelector('.toasts')
    expect([...(stack?.children ?? [])].map((row) => row.textContent)).toEqual([
      'copied',
      'seat held',
    ])
    expect(screen.getByText('copied').closest('.toast')).toHaveClass('toast', 'info')
    expect(screen.getByText('seat held').closest('.toast')).toHaveClass('toast', 'error')
  })

  it('announces info politely and errors assertively', () => {
    renderToasts([toast('copied'), toast('seat held', 'error')])

    const info = screen.getByRole('status')
    const error = screen.getByRole('alert')
    expect(info).toHaveTextContent('copied')
    expect(error).toHaveTextContent('seat held')
    expect(info).toHaveAttribute('aria-atomic', 'true')
    expect(error).toHaveAttribute('aria-atomic', 'true')
  })

  it('keeps the wrapper free of live semantics', () => {
    const { container } = renderToasts([toast('copied')])

    expect(container.querySelector('.toasts')).not.toHaveAttribute('aria-live')
  })

  it('offers a named close control per row', () => {
    renderToasts([toast('copied'), toast('seat held', 'error')])

    expect(screen.getAllByRole('button', { name: 'Dismiss notification' })).toHaveLength(2)
  })

  it('dismisses only the row whose control was used', async () => {
    const copied = toast('copied')
    const held = toast('seat held', 'error')
    const { onDismiss } = renderToasts([copied, held])

    await userEvent
      .setup()
      .click(screen.getAllByRole('button', { name: 'Dismiss notification' })[1]!)

    expect(onDismiss).toHaveBeenCalledExactlyOnceWith(held.id)
  })

  it('keeps the stack mounted when empty', () => {
    const { container } = renderToasts([])

    expect(container.querySelector('.toasts')).toBeInTheDocument()
    expect(container.querySelector('.toast')).not.toBeInTheDocument()
  })

  it('drops rows the hook already expired', () => {
    const copied = toast('copied')
    const held = toast('seat held', 'error')
    const view = renderToasts([copied, held])
    expect(screen.getByText('copied')).toBeInTheDocument()

    view.rerender(
      <Toasts
        toasts={[held]}
        onDismiss={view.onDismiss}
        onPause={view.onPause}
        onResume={view.onResume}
      />,
    )
    expect(screen.queryByText('copied')).not.toBeInTheDocument()
  })

  it('holds the expiry for a mouse but not a touch', async () => {
    const user = userEvent.setup()
    const copied = toast('copied')
    const { onPause, onResume } = renderToasts([copied])
    const row = screen.getByRole('status')

    await user.hover(row)
    expect(onPause).toHaveBeenCalledExactlyOnceWith(copied.id)

    await user.unhover(row)
    expect(onResume).toHaveBeenCalledExactlyOnceWith(copied.id)

    // a finger raises the same enter pair, but only a mouse may hold the row
    fireEvent.pointerOver(row, { pointerType: 'touch' })
    expect(onPause).toHaveBeenCalledTimes(1)
    fireEvent.pointerOut(row, { pointerType: 'touch', relatedTarget: document.body })
    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it('holds the expiry while the close control has focus', () => {
    const copied = toast('copied')
    const { onPause, onResume } = renderToasts([copied])
    const close = screen.getByRole('button', { name: 'Dismiss notification' })

    close.focus()
    expect(onPause).toHaveBeenCalledExactlyOnceWith(copied.id)

    close.blur()
    expect(onResume).toHaveBeenCalledExactlyOnceWith(copied.id)
  })

  it('keeps the focus hold after the pointer leaves', async () => {
    const user = userEvent.setup()
    const copied = toast('copied')
    const { onResume } = renderToasts([copied])
    const row = screen.getByRole('status')
    const close = screen.getByRole('button', { name: 'Dismiss notification' })

    await user.hover(row)
    close.focus()
    await user.unhover(row)
    expect(onResume).not.toHaveBeenCalled()

    close.blur()
    expect(onResume).toHaveBeenCalledExactlyOnceWith(copied.id)
  })
})

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Toasts } from './Toasts'
import type { ToastView } from './useToasts'

// The shared stack both session chromes render: rows in arrival order with
// their level class inside one polite live region, fully driven by the list
// useToasts hands over.

let nextID = 0

function toast(text: string, level: ToastView['level'] = 'info'): ToastView {
  return { id: ++nextID, text, level }
}

describe('Toasts', () => {
  it('renders rows in arrival order with their level', () => {
    const { container } = render(<Toasts toasts={[toast('copied'), toast('seat held', 'error')]} />)

    const stack = container.querySelector('.toasts')
    expect([...(stack?.children ?? [])].map((row) => row.textContent)).toEqual([
      'copied',
      'seat held',
    ])
    expect(screen.getByText('copied')).toHaveClass('toast', 'info')
    expect(screen.getByText('seat held')).toHaveClass('toast', 'error')
  })

  it('announces through one polite live region', () => {
    const { container } = render(<Toasts toasts={[toast('copied')]} />)

    expect(container.querySelector('.toasts')).toHaveAttribute('aria-live', 'polite')
  })

  it('keeps the stack mounted when empty', () => {
    const { container } = render(<Toasts toasts={[]} />)

    expect(container.querySelector('.toasts')).toBeInTheDocument()
    expect(container.querySelector('.toast')).not.toBeInTheDocument()
  })

  it('drops rows the hook already expired', () => {
    const copied = toast('copied')
    const held = toast('seat held', 'error')
    const view = render(<Toasts toasts={[copied, held]} />)
    expect(screen.getByText('copied')).toBeInTheDocument()

    view.rerender(<Toasts toasts={[held]} />)
    expect(screen.queryByText('copied')).not.toBeInTheDocument()
  })
})

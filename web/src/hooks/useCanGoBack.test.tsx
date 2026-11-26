import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { MemoryRouter, useNavigate } from 'react-router'
import { describe, expect, it } from 'vitest'

import { useCanGoBack } from './useCanGoBack'

// The hook reads the router's own history facts, so every case drives a real
// MemoryRouter: a lone initial entry is cold, a pushed entry has an in-app
// entry behind it, and a replace landing rewrites the key over an empty stack.

// Probe shows the hook's answer and navigates onto a second entry like a
// launcher tap does.
function Probe({ replace }: { replace?: boolean }): ReactElement {
  const navigate = useNavigate()
  const canGoBack = useCanGoBack()
  return (
    <>
      <span data-testid="can-go-back">{String(canGoBack)}</span>
      <button type="button" onClick={() => navigate('/next', { replace })}>
        open
      </button>
    </>
  )
}

describe('useCanGoBack', () => {
  it('reads false on a cold entry', () => {
    render(
      <MemoryRouter>
        <Probe />
      </MemoryRouter>,
    )

    expect(screen.getByTestId('can-go-back')).toHaveTextContent('false')
  })

  it('reads true behind a pushed entry', async () => {
    render(
      <MemoryRouter>
        <Probe />
      </MemoryRouter>,
    )

    await userEvent.setup().click(screen.getByRole('button', { name: 'open' }))
    expect(screen.getByTestId('can-go-back')).toHaveTextContent('true')
  })

  it('reads false after a replace landing', async () => {
    render(
      <MemoryRouter>
        <Probe replace />
      </MemoryRouter>,
    )

    await userEvent.setup().click(screen.getByRole('button', { name: 'open' }))
    expect(screen.getByTestId('can-go-back')).toHaveTextContent('false')
  })
})

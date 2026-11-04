import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import AuthGate from './AuthGate'
import { AuthProvider } from './providers/auth'

// LocationProbe prints where the router landed, so tests can read both halves
// of the login redirect contract: the /login URL and the state riding with it.
function LocationProbe(): ReactElement {
  const location = useLocation()
  return (
    <div>
      <span data-testid="url">{location.pathname}</span>
      <span data-testid="search">{location.search}</span>
      <span data-testid="state">{JSON.stringify(location.state ?? null)}</span>
    </div>
  )
}

describe('AuthGate', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function renderGate(initialEntry: string) {
    return render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LocationProbe />} />
            <Route path="*" element={<AuthGate />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )
  }

  it.each([
    ['tile selection', '/tile?open=a,b'],
    ['session deep link', '/s/01ABC?tab=files'],
  ])('keeps path and query when an expired session redirects (%s)', async (_name, start) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ error: 'unauthorized' }, { status: 401 }))),
    )
    renderGate(start)

    expect(await screen.findByTestId('url')).toHaveTextContent('/login')
    expect(screen.getByTestId('search').textContent).toBe('')
    expect(screen.getByTestId('state').textContent).toBe(JSON.stringify({ from: start }))
  })
})

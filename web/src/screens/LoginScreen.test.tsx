import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import LoginScreen from './LoginScreen'
import { AuthProvider } from '../providers/auth'

type User = ReturnType<typeof userEvent.setup>

// LocationProbe prints the URL the router settled on, so restore behavior is
// observable after LoginScreen navigates itself away.
function LocationProbe(): ReactElement {
  const location = useLocation()
  return (
    <div>
      <span data-testid="url">{location.pathname}</span>
      <span data-testid="search">{location.search}</span>
    </div>
  )
}

describe('LoginScreen', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // A fresh visitor reads /api/me as anon, and login flips the flag so the
  // follow-up me() succeeds like a cookie set would.
  let authed: boolean

  beforeEach(() => {
    authed = false
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const path = String(url).replace(/^https?:\/\/[^/]+/, '')
        if (path === '/api/auth/login' && init?.method === 'POST') {
          authed = true
          return Promise.resolve(new Response(null, { status: 204 }))
        }
        if (path === '/api/me') {
          return authed
            ? Promise.resolve(Response.json({ username: 'you', via: 'cookie' }))
            : Promise.resolve(Response.json({ error: 'unauthorized' }, { status: 401 }))
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${path}`)
      }),
    )
  })

  function renderLogin(state?: unknown) {
    return render(
      <MemoryRouter initialEntries={[{ pathname: '/login', state }]}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginScreen />} />
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )
  }

  async function signIn(user: User) {
    await user.type(screen.getByLabelText('Username'), 'you')
    await user.type(screen.getByLabelText('Password'), 'hunter2')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
  }

  // The probe splits path and search across spans, so the URL assertion below
  // joins both.
  function settledURL(): string {
    return screen.getByTestId('url').textContent + screen.getByTestId('search').textContent
  }

  it('returns to the saved path and query after signing in', async () => {
    const user = userEvent.setup()
    renderLogin({ from: '/tile?open=a,b' })

    await signIn(user)

    expect(await screen.findByTestId('url')).toBeInTheDocument()
    expect(settledURL()).toBe('/tile?open=a,b')
  })

  it('returns home when no target was saved', async () => {
    const user = userEvent.setup()
    renderLogin()

    await signIn(user)

    expect(await screen.findByTestId('url')).toBeInTheDocument()
    expect(settledURL()).toBe('/')
  })

  it.each([
    ['absolute url', 'https://evil.example/tile?open=a,b'],
    ['protocol-relative url', '//evil.example/tile'],
    ['backslash url', '/\\evil.example'],
  ])('falls back home for an unsafe saved target (%s)', async (_name, from) => {
    const user = userEvent.setup()
    renderLogin({ from })

    await signIn(user)

    expect(await screen.findByTestId('url')).toBeInTheDocument()
    expect(settledURL()).toBe('/')
  })

  it('humanizes rejected credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const path = String(url).replace(/^https?:\/\/[^/]+/, '')
        if (path === '/api/auth/login' && init?.method === 'POST') {
          return Promise.resolve(Response.json({ error: 'invalid_credentials' }, { status: 401 }))
        }
        if (path === '/api/me') {
          return Promise.resolve(Response.json({ error: 'unauthorized' }, { status: 401 }))
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${path}`)
      }),
    )
    renderLogin()
    const user = userEvent.setup()
    await signIn(user)

    expect(await screen.findByText('Wrong username or password.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })

  it('names the retry wait when login is throttled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json(
            { error: 'rate_limited', message: 'too many failed attempts; retry later' },
            { status: 429, headers: { 'Retry-After': '95' } },
          ),
        ),
      ),
    )
    renderLogin()
    const user = userEvent.setup()
    await signIn(user)

    expect(
      await screen.findByText('Too many attempts. Try again in 2 minutes.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })

  it('returns a signed-in visitor to the saved target', async () => {
    authed = true
    renderLogin({ from: '/sessions?focus=01A' })

    // /api/me resolves first, so the redirect happens without signing in
    expect(await screen.findByTestId('url')).toBeInTheDocument()
    expect(settledURL()).toBe('/sessions?focus=01A')
  })
})

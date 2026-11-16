import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import BootstrapScreen from './BootstrapScreen'
import { AuthProvider } from '../providers/auth'

// BootstrapScreen stands alone behind the auth gate, so it renders directly
// under the provider. /api/me always answers bootstrap-required.
describe('BootstrapScreen', () => {
  const fetchSpy = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchSpy.mockReset()
    fetchSpy.mockImplementation(() =>
      Promise.resolve(Response.json({ error: 'bootstrap_required' }, { status: 503 })),
    )
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function renderScreen() {
    return render(
      <AuthProvider>
        <BootstrapScreen />
      </AuthProvider>,
    )
  }

  async function fillPasswords(user: ReturnType<typeof userEvent.setup>, password: string) {
    await user.type(screen.getByLabelText('New password'), password)
    await user.type(screen.getByLabelText('Confirm password'), password)
    await user.click(screen.getByRole('button', { name: 'Save password' }))
  }

  it('rejects an over long password before submitting', async () => {
    renderScreen()
    const user = userEvent.setup()
    await fillPasswords(user, 'a'.repeat(73))

    expect(await screen.findByText('Password is too long. Use at most 72 bytes.')).toBeVisible()
    expect(fetchSpy.mock.calls.some(([url]) => String(url) === '/api/auth/bootstrap')).toBe(false)
  })

  it('measures multibyte passwords in bytes', async () => {
    renderScreen()
    const user = userEvent.setup()
    await fillPasswords(user, 'ü'.repeat(37)) // 74 bytes

    expect(await screen.findByText('Password is too long. Use at most 72 bytes.')).toBeVisible()
  })

  it('humanizes a throttled bootstrap with the retry wait', async () => {
    fetchSpy.mockImplementation((url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === '/api/auth/bootstrap' && init?.method === 'POST') {
        return Promise.resolve(
          Response.json(
            { error: 'rate_limited', message: 'too many failed attempts; retry later' },
            { status: 429, headers: { 'Retry-After': '10' } },
          ),
        )
      }
      return Promise.resolve(Response.json({ error: 'bootstrap_required' }, { status: 503 }))
    })
    renderScreen()
    const user = userEvent.setup()
    await fillPasswords(user, 'hunter2')

    expect(
      await screen.findByText('Too many attempts. Try again in 10 seconds.'),
    ).toBeInTheDocument()
  })
})

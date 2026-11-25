import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import BootstrapScreen from './BootstrapScreen'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'
import { MockWebSocket } from '../test/mockWebSocket'

// BootstrapScreen stands alone behind the auth gate, so it renders under the
// full provider stack like every route surface. /api/me always answers
// bootstrap-required.
describe('BootstrapScreen', () => {
  const fetchSpy = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchSpy.mockReset()
    fetchSpy.mockImplementation(() =>
      Promise.resolve(Response.json({ error: 'bootstrap_required' }, { status: 503 })),
    )
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function renderScreen() {
    return render(
      <MemoryRouter>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <BootstrapScreen />
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
  }

  async function fillPasswords(user: ReturnType<typeof userEvent.setup>, password: string) {
    await user.type(screen.getByLabelText('New password'), password)
    await user.type(screen.getByLabelText('Confirm password'), password)
    await user.click(screen.getByRole('button', { name: 'Save password' }))
  }

  it('titles the tab for first-run setup', () => {
    renderScreen()

    expect(document.title).toBe('Set password · ajent-swarm')
  })

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

    const wait = 'Too many attempts. Try again in 10 seconds.'
    expect(await screen.findByText(wait)).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(wait)
  })
})

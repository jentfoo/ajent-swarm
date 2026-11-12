import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AuthProvider, useAuth } from './auth'
import { request } from '../api/client'

// Probe drives the gate machine directly: the span mirrors the status and the
// buttons fire one bootstrap and one login attempt.
function Probe() {
  const { status, bootstrap, login } = useAuth()
  return (
    <div>
      <span data-testid="status">{status}</span>
      <button onClick={() => void bootstrap('hunter2').catch(() => {})}>Bootstrap</button>
      <button onClick={() => void login('you', 'hunter2').catch(() => {})}>Login</button>
    </div>
  )
}

describe('AuthProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubAuth(bootstrapReply: () => Response) {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const path = String(url).replace(/^https?:\/\/[^/]+/, '')
        if (path === '/api/me') {
          // the pending-service answer, mirroring the gate middleware envelope
          return Promise.resolve(Response.json({ error: 'bootstrap_required' }, { status: 503 }))
        }
        if (path === '/api/auth/bootstrap' && init?.method === 'POST') {
          return Promise.resolve(bootstrapReply())
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${path}`)
      }),
    )
  }

  // statusIs covers both the mount settle and post-submit transitions, since
  // the span exists from the first render and only its text changes.
  async function statusIs(expected: string) {
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe(expected))
  }

  // Renders against a service with no password yet and waits for the gate to
  // settle before any submit.
  async function mountAtBootstrap(bootstrapReply: () => Response) {
    stubAuth(bootstrapReply)
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await statusIs('bootstrap')
  }

  async function attemptBootstrap(bootstrapReply: () => Response) {
    await mountAtBootstrap(bootstrapReply)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Bootstrap' }))
  }

  it('drops to the login state when another tab bootstrapped first', async () => {
    await attemptBootstrap(() => Response.json({ error: 'already_bootstrapped' }, { status: 409 }))
    await statusIs('anon')
  })

  it('stays on the bootstrap screen for other failures', async () => {
    await attemptBootstrap(() => Response.json({ error: 'invalid_request' }, { status: 400 }))
    await statusIs('bootstrap')
  })

  it('clears the gate after a successful bootstrap', async () => {
    await attemptBootstrap(() => new Response(null, { status: 204 }))
    await statusIs('anon')
  })

  // stubLoginFlow covers the sign-in sequence: the mount me is anon, login
  // sets the cookie, the next me is authed. sessionsReply feeds any /api/
  // sessions poll dispatched alongside the flow.
  function stubLoginFlow(sessionsReply: () => Promise<Response>) {
    let meCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const path = String(url).replace(/^https?:\/\/[^/]+/, '')
        if (path === '/api/sessions') return sessionsReply()
        if (path === '/api/me') {
          meCalls++
          return meCalls === 1
            ? Promise.resolve(Response.json({ error: 'unauthorized' }, { status: 401 }))
            : Promise.resolve(Response.json({ username: 'you' }))
        }
        if (path === '/api/auth/login' && init?.method === 'POST') {
          return Promise.resolve(new Response(null, { status: 204 }))
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${path}`)
      }),
    )
  }

  it('stays authed when a pre-login poll resolves 401 late', async () => {
    let settleStale!: (reply: Response) => void
    const staleReply = new Promise<Response>((resolve) => {
      settleStale = resolve
    })
    stubLoginFlow(() => staleReply)
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await statusIs('anon')
    // the poll leaves before the cookie exists, its 401 lands after login
    const stale = request('/api/sessions').catch(() => undefined)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Login' }))
    await statusIs('authed')
    await act(async () => {
      settleStale(Response.json({ error: 'unauthorized' }, { status: 401 }))
      await stale
    })
    expect(screen.getByTestId('status').textContent).toBe('authed')
  })

  it('drops to anon when a post-login request resolves 401', async () => {
    stubLoginFlow(() => Promise.resolve(Response.json({ error: 'unauthorized' }, { status: 401 })))
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await statusIs('anon')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Login' }))
    await statusIs('authed')
    await act(async () => {
      await request('/api/sessions').catch(() => undefined)
    })
    await statusIs('anon')
  })
})

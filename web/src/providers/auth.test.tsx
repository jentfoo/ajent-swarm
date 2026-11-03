import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AuthProvider, useAuth } from './auth'

// Probe drives the gate machine directly: the span mirrors the status and the
// button fires one bootstrap attempt.
function Probe() {
  const { status, bootstrap } = useAuth()
  return (
    <div>
      <span data-testid="status">{status}</span>
      <button onClick={() => void bootstrap('hunter2').catch(() => {})}>Bootstrap</button>
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
})

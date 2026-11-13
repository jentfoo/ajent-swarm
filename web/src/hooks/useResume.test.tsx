import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useResume } from './useResume'

// The shared resume path against fetch stubs shaped like the Go handlers
// answer: one launch call carrying mode resume, navigation to the new session,
// inline refusals, and per-target busy tracking that drops overlapping clicks.

function Harness({ onResumed }: { onResumed?: (sessionId: string) => void | Promise<void> }) {
  const { resume, resumingId, error } = useResume(onResumed)
  const location = useLocation()
  return (
    <div>
      {/* fixed workspace and target; the request shape is under test */}
      <button type="button" onClick={() => void resume('/w', '01T')}>
        resume
      </button>
      <span data-testid="resuming">{resumingId ?? ''}</span>
      <span data-testid="error">{error}</span>
      <span data-testid="path">{location.pathname}</span>
    </div>
  )
}

describe('useResume', () => {
  let launches: unknown[]

  beforeEach(() => {
    localStorage.clear()
    launches = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function renderHarness(onResumed?: (sessionId: string) => void | Promise<void>) {
    return render(
      <MemoryRouter initialEntries={['/']}>
        <Harness onResumed={onResumed} />
      </MemoryRouter>,
    )
  }

  it('launches headless resume and navigates to the session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const path = String(url)
        if (path === '/api/sessions' && init?.method === 'POST') {
          launches.push(JSON.parse(String(init.body)))
          return Response.json({ sessionId: '01R', pid: 7 })
        }
        throw new Error(`unexpected fetch ${path}`)
      }),
    )

    const user = userEvent.setup()
    renderHarness()

    await user.click(screen.getByRole('button', { name: 'resume' }))

    expect(launches).toEqual([{ workspace: '/w', mode: 'resume', target: '01T' }])
    await vi.waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent('/s/01R')
    })
  })

  it('surfaces a refusal inline and stays put', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const path = String(url)
        if (path === '/api/sessions' && init?.method === 'POST') {
          launches.push(JSON.parse(String(init.body)))
          return Response.json({ error: 'unavailable', message: 'gone' }, { status: 409 })
        }
        throw new Error(`unexpected fetch ${path}`)
      }),
    )

    const user = userEvent.setup()
    renderHarness()

    await user.click(screen.getByRole('button', { name: 'resume' }))

    expect(await screen.findByTestId('error')).toHaveTextContent('gone')
    expect(screen.getByTestId('path')).toHaveTextContent('/')
  })

  it('drops overlapping clicks while one resume is in flight', async () => {
    let release: (() => void) | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const path = String(url)
        if (path === '/api/sessions' && init?.method === 'POST') {
          launches.push(JSON.parse(String(init.body)))
          // held open until the test releases it, so overlap is observable
          return new Promise<Response>((resolve) => {
            release = () => resolve(Response.json({ sessionId: '01R', pid: 7 }))
          })
        }
        throw new Error(`unexpected fetch ${path}`)
      }),
    )

    const user = userEvent.setup()
    renderHarness()

    await user.click(screen.getByRole('button', { name: 'resume' }))
    await user.click(screen.getByRole('button', { name: 'resume' }))

    expect(screen.getByTestId('resuming')).toHaveTextContent('01T')
    await act(async () => {
      release?.()
    })

    await vi.waitFor(() => {
      expect(launches).toEqual([{ workspace: '/w', mode: 'resume', target: '01T' }])
      expect(screen.getByTestId('path')).toHaveTextContent('/s/01R')
    })
  })

  it('reports to onResumed instead of navigating', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const path = String(url)
        if (path === '/api/sessions' && init?.method === 'POST') {
          launches.push(JSON.parse(String(init.body)))
          return Response.json({ sessionId: '01R', pid: 7 })
        }
        throw new Error(`unexpected fetch ${path}`)
      }),
    )
    const onResumed = vi.fn()

    const user = userEvent.setup()
    renderHarness(onResumed)

    await user.click(screen.getByRole('button', { name: 'resume' }))

    await vi.waitFor(() => expect(onResumed).toHaveBeenCalledWith('01R'))
    expect(screen.getByTestId('path')).toHaveTextContent('/')
  })
})

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import MobileSettings from './MobileSettings'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'

// The full-screen settings entry point: theme and density live here rather
// than in mobile chrome, above the shared menu for one chosen live session.

const LIVE = '01LIVESETTINGS00000'

function renderSettings() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <SwarmProvider>
          <WorkspaceProvider>
            <MobileSettings />
          </WorkspaceProvider>
        </SwarmProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('MobileSettings', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const path = String(url).split('?')[0]
        if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        if (path === '/api/sessions') {
          return Response.json([{ sessionId: LIVE, state: 'online', spawnedBy: 'swarm' }])
        }
        if (path === '/api/attention') return Response.json([])
        if (path === `/api/sessions/${LIVE}/settings`) {
          return Response.json({ rows: [] })
        }
        throw new Error(`unexpected fetch ${String(url)}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('toggles theme and density from inside settings', async () => {
    renderSettings()
    await screen.findByRole('heading', { name: 'Settings' })

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Light' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    await user.click(screen.getByRole('button', { name: 'Compact' }))
    expect(document.documentElement.dataset.density).toBe('compact')
  })

  it('serves the shared menu for the first live session', async () => {
    renderSettings()

    // the picker falls back to the only live session without a manual choice
    expect(await screen.findByLabelText('Session')).toHaveValue(LIVE)
    expect(screen.getByLabelText('Agent settings')).toBeInTheDocument()
  })

  it('explains the missing sessions case', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const path = String(url).split('?')[0]
        if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        if (path === '/api/sessions' || path === '/api/attention') return Response.json([])
        throw new Error(`unexpected fetch ${String(url)}`)
      }),
    )

    renderSettings()
    expect(
      await screen.findByText("No live sessions. Agent settings ride a session's control socket."),
    ).toBeInTheDocument()
  })
})

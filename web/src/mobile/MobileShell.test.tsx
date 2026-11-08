import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import MobileShell from './MobileShell'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'
import { MockWebSocket } from '../test/mockWebSocket'
import { resetLedger } from '../workspace/attention'

// The shell rides the real provider stack over fetch and WebSocket mocks, and
// the route table stays a catch-all: the pathname decides the active tab, not
// the mounted screen.

function LocationProbe(): ReactElement {
  const location = useLocation()
  return <span data-testid="url">{location.pathname}</span>
}

describe('MobileShell', () => {
  let routes: Map<string, () => Response>

  beforeEach(() => {
    localStorage.clear()
    resetLedger()
    vi.stubGlobal('WebSocket', MockWebSocket)
    routes = new Map<string, () => Response>([
      ['/api/me', () => Response.json({ username: 'you', via: 'cookie' })],
      ['/api/sessions', () => Response.json([])],
      // one open dialog so the badge renders, and its arrival settles the
      // provider reads before assertions run
      [
        '/api/attention',
        () =>
          Response.json([
            { sessionId: 's1', pid: 7, openInteractions: 1, dialogId: 3, running: false },
          ]),
      ],
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) => {
        const path = String(url)
          .replace(/^https?:\/\/[^/]+/, '')
          .split('?')[0]
        const respond = routes.get(path)
        if (!respond) throw new Error(`unexpected fetch ${path}`)
        return Promise.resolve(respond())
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function renderShell(initialEntry: string) {
    render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <Routes>
                <Route
                  path="*"
                  element={
                    <MobileShell>
                      <LocationProbe />
                    </MobileShell>
                  }
                />
              </Routes>
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    // settle the mount-time auth and discovery reads inside act
    await screen.findByRole('link', { name: '1 sessions need input' })
  }

  it.each([
    ['/', 'Workspace'],
    ['/focused', 'Workspace'],
    ['/tile?open=a,b', 'Workspace'],
    ['/sessions', 'Sessions'],
    ['/s/01ABC0000000', 'Sessions'],
    ['/jobs', 'Jobs'],
    ['/jobs/runs', 'Jobs'],
    ['/jobs/01JOB0000000', 'Jobs'],
    ['/m/settings', null],
    ['/m/read/01ENDED00000000', null],
  ])('highlights exactly one tab on %s', async (path, active) => {
    await renderShell(path)

    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
    for (const name of ['Workspace', 'Sessions', 'Jobs']) {
      const el = screen.getByRole('link', { name })
      if (name === active) expect(el).toHaveClass('active')
      else expect(el).not.toHaveClass('active')
    }
  })

  it('reaches Jobs and back from a deep-linked ended session', async () => {
    await renderShell('/m/read/01ENDED00000000')
    const user = userEvent.setup()

    await user.click(screen.getByRole('link', { name: 'Jobs' }))
    expect(await screen.findByTestId('url')).toHaveTextContent('/jobs')

    await user.click(screen.getByRole('link', { name: 'Workspace' }))
    expect(await screen.findByTestId('url')).toHaveTextContent('/')
  })
})

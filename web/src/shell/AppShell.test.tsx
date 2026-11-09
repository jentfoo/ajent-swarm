import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AppShell from './AppShell'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'
import { MockWebSocket } from '../test/mockWebSocket'
import { mobileLayout } from '../hooks/useMediaQuery'

// The shell rides the real provider stack over fetch and WebSocket mocks, so
// the switcher gating reads exactly what production renders. The route table
// stays a catch-all: the pathname decides the chrome, not the mounted screen.

function LocationProbe(): ReactElement {
  const location = useLocation()
  return <span data-testid="url">{location.pathname}</span>
}

describe('AppShell', () => {
  let routes: Map<string, () => Response>

  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('WebSocket', MockWebSocket)
    routes = new Map<string, () => Response>([
      ['/api/me', () => Response.json({ username: 'you', via: 'cookie' })],
      ['/api/sessions', () => Response.json([])],
      ['/api/attention', () => Response.json([])],
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
    const result = render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <Routes>
                <Route
                  path="*"
                  element={
                    <AppShell>
                      <LocationProbe />
                    </AppShell>
                  }
                />
              </Routes>
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    // settle the mount-time auth and discovery reads inside act
    await screen.findByText('you')
    return result
  }

  function switcher() {
    return screen.queryByRole('group', { name: 'Workspace mode' })
  }

  it.each([
    ['/', 'Workspace'],
    ['/focused', 'Workspace'],
    ['/tile', 'Workspace'],
    ['/sessions', 'Sessions'],
    ['/s/01ABC0000000', 'Sessions'],
    ['/jobs/runs', 'Jobs'],
  ])('highlights exactly one nav link on %s', async (path, active) => {
    await renderShell(path)

    for (const name of ['Workspace', 'Sessions', 'Jobs']) {
      const el = screen.getByRole('link', { name })
      if (name === active) expect(el).toHaveClass('active')
      else expect(el).not.toHaveClass('active')
    }
  })

  it.each([
    ['root', '/'],
    ['focused', '/focused'],
    ['tile', '/tile'],
  ])('shows the switcher on workspace routes (%s)', async (_name, path) => {
    await renderShell(path)

    expect(switcher()).toBeInTheDocument()
    // the same predicate bleeds main under the chrome on exactly these paths
    expect(document.querySelector('main')).toHaveClass('workspace-content')
  })

  it.each([
    ['sessions', '/sessions'],
    ['jobs', '/jobs'],
    ['session view', '/s/01ABC0000000000'],
  ])('hides the switcher off workspace routes (%s)', async (_name, path) => {
    await renderShell(path)

    expect(switcher()).not.toBeInTheDocument()
    expect(document.querySelector('main')).not.toHaveClass('workspace-content')
  })

  it('keeps desktop chrome at phone width', async () => {
    // shell choice under the breakpoint belongs to AuthGate, AppShell has no
    // phone-width branches, so matchMedia reporting mobile changes nothing here
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === mobileLayout,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }))
    await renderShell('/')

    expect(switcher()).toBeInTheDocument()
    // the removed bottom navigation stays gone
    expect(document.querySelector('.mobile-nav')).not.toBeInTheDocument()
  })

  it('names the attention badge for screen readers', async () => {
    routes.set('/api/attention', () =>
      Response.json([
        {
          sessionId: 's1',
          pid: 7,
          openInteractions: 1,
          dialogId: 3,
          running: false,
          idle: true,
          kind: 'needs-input',
          reason: 'Allow write access?',
        },
      ]),
    )
    await renderShell('/')

    const badge = screen.getByRole('button', { name: '1 sessions need input' })
    expect(badge).toHaveAttribute('aria-label', '1 sessions need input')
    expect(badge).toHaveAttribute('title', '1 session(s) need input')
  })

  it('keeps the switcher when a mode press navigates within workspaces', async () => {
    await renderShell('/')
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Tile' }))

    // tiling with nothing live lands on the bare tile route, still gated in
    expect(await screen.findByTestId('url')).toHaveTextContent('/tile')
    expect(switcher()).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tile' })).toHaveAttribute('aria-pressed', 'true')
  })
})

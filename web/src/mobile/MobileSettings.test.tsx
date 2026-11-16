import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import MobileSettings from './MobileSettings'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'

// The full-screen global settings entry point: theme, the notification
// permission and swarm's own settings live here, per-session agent settings
// ride each session screen instead.

const REGISTRY = [
  { key: 'anthropic/claude-sonnet', short: 'sonnet', window: 200000, caps: {} },
  { key: 'anthropic/claude-haiku', short: 'haiku', window: 100000, caps: {} },
]

// jsdom ships no Notification, the stand-in pins one permission per mount.
function stubNotification(permission: 'granted' | 'denied') {
  vi.stubGlobal(
    'Notification',
    class {
      static permission = permission
    },
  )
}

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
        if (path === '/api/settings') return Response.json({ titleModel: '' })
        if (path === '/api/models/options') return Response.json(REGISTRY)
        return Response.json([])
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('toggles theme from inside settings', async () => {
    renderSettings()
    await screen.findByRole('heading', { name: 'Settings' })

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Light' }))
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('offers the titling model picker with the registry union', async () => {
    renderSettings()

    const select = await screen.findByLabelText('Session titling model')
    expect(select).toHaveValue('') // unset reads as the default
    const options = select.querySelectorAll('option')
    expect(options[0]?.textContent).toBe('Session model (default)')
    expect([...options].map((o) => o.textContent)).toEqual([
      'Session model (default)',
      'sonnet',
      'haiku',
    ])
  })

  it('saves a titling model through the settings endpoint', async () => {
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url).split('?')[0]
      if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
      if (path === '/api/settings') {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as { titleModel: string }
          return Response.json({ titleModel: body.titleModel })
        }
        return Response.json({ titleModel: '' })
      }
      if (path === '/api/models/options') return Response.json(REGISTRY)
      return Response.json([])
    })
    vi.stubGlobal('fetch', fetchSpy)

    renderSettings()
    const user = userEvent.setup()
    await user.selectOptions(await screen.findByLabelText('Session titling model'), 'haiku')

    await vi.waitFor(() => {
      const calls = fetchSpy.mock.calls.filter(
        ([u, init]) => String(u) === '/api/settings' && init?.method === 'PUT',
      )
      expect(calls).toHaveLength(1)
      expect(JSON.parse(String(calls[0]![1]?.body))).toEqual({
        titleModel: 'anthropic/claude-haiku',
      })
    })
    expect(screen.getByLabelText('Session titling model')).toHaveValue('anthropic/claude-haiku')
  })

  it('offers the manual notification enable path when undecided', async () => {
    // the stand-in's permission flips when the browser prompt would resolve
    let current = 'default'
    vi.stubGlobal(
      'Notification',
      class {
        static get permission() {
          return current
        }
        static requestPermission = vi.fn(async () => {
          current = 'granted'
          return 'granted'
        })
      },
    )

    renderSettings()
    expect(await screen.findByText('Off')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Enable' }))

    // the row follows the grant to its settled status
    expect(await screen.findByText('On')).toBeInTheDocument()
  })

  it.each([
    ['granted', 'On'],
    ['denied', 'Blocked in browser settings'],
  ] as const)('reports %s as settled without an action', async (permission, status) => {
    stubNotification(permission)

    renderSettings()
    expect(await screen.findByText(status)).toBeInTheDocument()
    // only the undecided state carries an action
    expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument()
  })

  it('reports a missing notification api without an action', async () => {
    vi.stubGlobal('Notification', undefined)

    renderSettings()
    expect(await screen.findByText('Not available here')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument()
  })

  it('signs out from its account section', async () => {
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = String(url).split('?')[0]
      if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
      if (path === '/api/settings') return Response.json({ titleModel: '' })
      if (path === '/api/models/options') return Response.json(REGISTRY)
      if (path === '/api/auth/logout' && init?.method === 'POST') return Response.json({})
      return Response.json([])
    })
    vi.stubGlobal('fetch', fetchSpy)

    renderSettings()
    expect(await screen.findByText('you')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    // the logout round trip ran and the principal cleared with it
    await vi.waitFor(() => {
      const calls = fetchSpy.mock.calls.filter(
        ([u, init]) => String(u) === '/api/auth/logout' && init?.method === 'POST',
      )
      expect(calls).toHaveLength(1)
      expect(screen.queryByText('you')).not.toBeInTheDocument()
    })
  })
})

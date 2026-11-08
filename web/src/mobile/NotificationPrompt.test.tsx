import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import NotificationPrompt from './NotificationPrompt'
import type { AttentionRow } from '../api/types'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'

// The contextual opt-in rides the needs-input moment on mobile: it appears
// only while permission is undecided and a session waits, offers one tap to
// grant, and never repeats once refused for this visit.

let permission: 'default' | 'granted' | 'denied'
let requestPermission: ReturnType<typeof vi.fn>

function needRow(sessionId = 's1'): AttentionRow {
  return {
    sessionId,
    pid: 1,
    openInteractions: 1,
    running: false,
    idle: false,
    kind: 'needs-input',
    reason: 'Allow write access?',
  }
}

describe('NotificationPrompt', () => {
  beforeEach(() => {
    localStorage.clear()
    permission = 'default'
    // jsdom ships no Notification; the stand-in keeps a mutable permission.
    requestPermission = vi.fn(async () => {
      permission = 'granted'
      return 'granted'
    })
    vi.stubGlobal(
      'Notification',
      class {
        static get permission() {
          return permission
        }
        static requestPermission = requestPermission
      },
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // mount renders the prompt under the real provider stack with the digest
  // poll answering `attention`; unmount before mounting again, since two live
  // prompts would double every query.
  function mount(attention: AttentionRow[]) {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const path = String(url).split('?')[0]
      if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
      if (path === '/api/attention') return Response.json(attention)
      return Response.json([])
    })
    vi.stubGlobal('fetch', fetchMock)
    const view = render(
      <MemoryRouter>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <NotificationPrompt />
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    return { fetchMock, view }
  }

  // digestLanded waits for the attention poll to resolve and its state update
  // to land, so a hidden prompt reflects a decision rather than an unanswered
  // mount.
  async function digestLanded(fetchMock: ReturnType<typeof vi.fn>) {
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/attention')).toBe(true),
    )
    await act(async () => {})
  }

  const banner = () => screen.queryByRole('region', { name: 'Enable notifications' })

  it('stays hidden without needs input', async () => {
    const { fetchMock } = mount([])
    await digestLanded(fetchMock)
    expect(banner()).not.toBeInTheDocument()
  })

  it.each(['granted', 'denied'] as const)(
    'stays hidden once permission settles (%s)',
    async (settled) => {
      permission = settled
      const { fetchMock } = mount([needRow()])
      await digestLanded(fetchMock)
      expect(banner()).not.toBeInTheDocument()
    },
  )

  it('offers one tap to enable when a session needs input', async () => {
    mount([needRow()])

    await screen.findByText('Get notified when a session needs input.')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Enable notifications' }))

    // the grant rides the tap's own gesture and resolves the banner away
    await vi.waitFor(() => {
      expect(requestPermission).toHaveBeenCalledTimes(1)
      expect(banner()).not.toBeInTheDocument()
    })
  })

  it('keeps Not now quiet for the rest of the visit', async () => {
    const first = mount([needRow()])
    await screen.findByText('Get notified when a session needs input.')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Not now' }))
    expect(banner()).not.toBeInTheDocument()

    // a later mount in the same visit stays quiet too; the seven-day retry and
    // permanent end live with the anti-nag state's own tests
    first.view.unmount()
    const second = mount([needRow()])
    await digestLanded(second.fetchMock)
    expect(banner()).not.toBeInTheDocument()
  })
})

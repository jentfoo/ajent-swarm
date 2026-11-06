import { renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSessionLabel } from './useSessionLabel'
import type { SessionStatus } from '../api/types'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider, useSwarm } from '../providers/swarm'
import { MockWebSocket } from '../test/mockWebSocket'

// The label hook reads the swarm listing exactly like the rail and switcher:
// the stored title, then the agent's own name, then the tilde-folded
// workspace, then the short id. The listing drives it, so a rename lands with
// the forced refresh and no second subscription.

const ID = '01LABELTEST00001'

function row(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId: ID,
    state: 'online',
    seatHeld: false,
    seatOurs: false,
    running: false,
    idle: true,
    queued: 0,
    openInteractions: 0,
    spawnedBy: 'swarm',
    ...overrides,
  }
}

// ProviderProbe surfaces the listing's row count and the provider's forced
// refresh (the way RenameControl drives it after a save), so tests can prove
// a listing landed and re-poll it without waiting out the discovery cadence.
function ProviderProbe() {
  const { sessions, refreshSessions } = useSwarm()
  return (
    <>
      <span data-testid="row-count">{sessions.length}</span>
      <button type="button" onClick={() => void refreshSessions()}>
        refresh
      </button>
    </>
  )
}

let listing: SessionStatus[]
let home: string | undefined
let fetchMock: ReturnType<typeof vi.fn>

function mountLabel() {
  return renderHook(() => useSessionLabel(ID), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <AuthProvider>
        <SwarmProvider>
          <ProviderProbe />
          {children}
        </SwarmProvider>
      </AuthProvider>
    ),
  })
}

describe('useSessionLabel', () => {
  beforeEach(() => {
    listing = []
    home = '/home/you'
    fetchMock = vi.fn(async (url: string | URL) => {
      const path = String(url).split('?')[0]
      if (path.endsWith('/api/me')) return Response.json({ username: 'you', home })
      if (path.endsWith('/api/sessions')) return Response.json(listing)
      return Response.json([])
    })
    vi.stubGlobal('fetch', fetchMock)
    // SwarmProvider connects a socket on mount; a silent stand-in keeps jsdom
    // from attempting a real one
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prefers the stored title over the agent name', async () => {
    listing = [row({ title: 'nightly sweep', name: 'fix the flaky test' })]
    const view = mountLabel()

    await waitFor(() => expect(view.result.current).toBe('nightly sweep'))
  })

  it('falls back to the agent name when no title is stored', async () => {
    listing = [row({ name: 'fix the flaky test' })]
    const view = mountLabel()

    await waitFor(() => expect(view.result.current).toBe('fix the flaky test'))
  })

  it('folds the workspace under the service home', async () => {
    listing = [row({ workspace: '/home/you/project' })]
    const view = mountLabel()

    // home arrives from /api/me after the first render, so the fold settles
    await waitFor(() => expect(view.result.current).toBe('~/project'))
  })

  it('keeps a foreign workspace absolute', async () => {
    listing = [row({ workspace: '/srv/data/project' })]
    const view = mountLabel()

    await waitFor(() => expect(view.result.current).toBe('/srv/data/project'))
  })

  it('shows the short id until the listing carries the session', async () => {
    // another session's row lands and still leaves this one unnamed
    listing = [row({ sessionId: '01OTHER000000001' })]
    const view = mountLabel()

    await waitFor(() => expect(screen.getByTestId('row-count').textContent).toBe('1'))
    expect(view.result.current).toBe('01LABELT…')
  })

  it('follows a rename on the forced listing refresh', async () => {
    listing = [row({ title: 'before' })]
    const view = mountLabel()
    await waitFor(() => expect(view.result.current).toBe('before'))

    listing[0] = row({ title: 'after' })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'refresh' }))

    expect(view.result.current).toBe('after')
  })
})

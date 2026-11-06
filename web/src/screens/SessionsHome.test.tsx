import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SessionsHome from './SessionsHome'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { MockWebSocket } from '../test/mockWebSocket'
import { ChildState, type SessionStatus } from '../api/types'

// The sessions grid renders over the real provider stack with fetch and
// WebSocket stubs: cards carry shared stop wording instead of raw reasons,
// held seats badge while free ones stay quiet, and the fact line drops
// placeholders for whatever is actually known.

function session(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId: '01A',
    state: ChildState.Online,
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

let sessionsReply: SessionStatus[]

describe('SessionsHome', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionsReply = [session()]
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const base = String(url)
          .replace(/^https?:\/\/[^/]+/, '')
          .split('?')[0]
        if (base === '/api/me')
          return Promise.resolve(Response.json({ username: 'you', via: 'cookie' }))
        if (base === '/api/sessions' && (!init?.method || init.method === 'GET')) {
          return Promise.resolve(Response.json(sessionsReply))
        }
        if (base === '/api/attention' || base === '/api/models' || base === '/api/tools/options') {
          return Promise.resolve(Response.json([]))
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${base}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function renderHome() {
    return render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <SwarmProvider>
            <Routes>
              <Route path="/" element={<SessionsHome />} />
              <Route path="/focused" element={<div>focused</div>} />
              <Route path="/s/:sessionId" element={<div>session</div>} />
            </Routes>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
  }

  it('badges held seats and stays quiet on free ones', async () => {
    sessionsReply = [
      session({ sessionId: '01A', seatHeld: true, seatHolder: 'tui', seatOurs: false }),
      session({ sessionId: '01B' }),
    ]
    renderHome()

    expect(await screen.findByText('seat: tui')).toBeInTheDocument()
    expect(screen.queryByText('seat free')).not.toBeInTheDocument()
  })

  it('summarizes the last stop in shared wording', async () => {
    sessionsReply = [
      session({ sessionId: '01A', lastStop: 'end_turn' }),
      session({ sessionId: '01B', lastStop: 'max_tokens' }),
    ]
    renderHome()

    expect(await screen.findByText('turn complete')).toBeInTheDocument()
    expect(screen.getByText('stopped: max tokens')).toBeInTheDocument()
    expect(screen.queryByText(/last stop:/)).not.toBeInTheDocument()
  })

  it('keeps the failed turn prefix for stop errors', async () => {
    sessionsReply = [session({ sessionId: '01A', lastStop: 'error', lastStopErr: 'boom' })]
    renderHome()

    expect(await screen.findByText('last turn failed: boom')).toBeInTheDocument()
  })

  it('renders the exit note on ended cards', async () => {
    sessionsReply = [
      session({ sessionId: '01A', state: ChildState.Exited, detail: 'ended on its own' }),
    ]
    renderHome()

    expect(await screen.findByText('ended on its own')).toBeInTheDocument()
  })

  it('renders only what the fact line knows', async () => {
    sessionsReply = [
      session({ sessionId: '01A' }),
      session({ sessionId: '01B', workspace: '/home/you/repo' }),
      session({ sessionId: '01C', model: 'p/m', workspace: '/repo' }),
    ]
    renderHome()

    await screen.findByText('p/m · repo')
    expect(screen.queryByText(/model unknown/)).not.toBeInTheDocument()
    // the fact line disappears when neither model nor workspace is known
    const cardA = screen.getByRole('checkbox', { name: 'Select 01A for tiling' }).closest('.card')!
    expect(cardA.querySelector('.muted')).toBeNull()
    expect(screen.getByText('repo')).toBeInTheDocument()
  })
})

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import MobileHome from './MobileHome'
import EndedSessionScreen from './EndedSessionScreen'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'

// Responsive smoke over the mobile launcher at its breakpoint: discovery rows,
// section links, and the launch form's workspace reveal. The backend round
// trip runs against fetch mocks shaped exactly like the Go handlers answer.

const LIVE = '01LIVESESSION000000'
const ENDED = '01ENDEDSESSION00000'

function liveRow() {
  return [
    {
      sessionId: LIVE,
      name: '',
      title: 'fix login flow',
      workspace: '/home/you/project',
      state: 'online',
      seatHeld: true,
      seatHolder: 'swarm',
      seatOurs: false,
      running: true,
      idle: false,
      openInteractions: 0,
      spawnedBy: 'swarm',
    },
    {
      sessionId: ENDED,
      workspace: '/home/you/old',
      state: 'exited',
      exitedAt: 5,
      seatHeld: false,
      seatOurs: false,
      running: false,
      idle: false,
      openInteractions: 0,
      spawnedBy: 'swarm',
    },
  ]
}

describe('MobileHome', () => {
  let fetcher: ReturnType<typeof buildFetcher>

  function buildFetcher() {
    const impl = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const path = String(url).split('?')[0]
      if (path === '/api/me')
        return Response.json({ username: 'you', via: 'cookie', home: '/home/you' })
      if (path === '/api/sessions') return Response.json(liveRow())
      if (path === '/api/attention') return Response.json([])
      throw new Error(`unexpected fetch ${String(url)}`)
    })
    return impl
  }

  beforeEach(() => {
    fetcher = buildFetcher()
    vi.stubGlobal('fetch', fetcher)
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function renderHome() {
    return render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <Routes>
                <Route path="/" element={<MobileHome />} />
                <Route path="/m/read/:sessionId" element={<EndedSessionScreen />} />
              </Routes>
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
  }

  it('lists live sessions by title with status badges', async () => {
    renderHome()

    // the stored swarm title wins over names and paths
    expect(await screen.findByText('fix login flow')).toBeInTheDocument()
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.getByText('ended')).toBeInTheDocument()
  })

  it('shows launcher sections for jobs and settings', async () => {
    renderHome()

    expect(await screen.findByTestId('link-jobs')).toHaveAttribute('href', '/jobs')
    expect(screen.getByTestId('link-settings')).toHaveAttribute('href', '/m/settings')

    // the launch form reveals a custom workspace path on demand
    await userEvent.setup().click(screen.getByRole('button', { name: 'Launch…' }))
    expect(screen.getByTestId('custom-workspace')).toBeInTheDocument()
  })

  it('opens an ended row read-only transcript route', async () => {
    fetcher.mockImplementation(async (url: string | URL) => {
      const path = String(url).split('?')[0]
      if (path === '/api/me')
        return Response.json({ username: 'you', via: 'cookie', home: '/home/you' })
      if (path === '/api/sessions') return Response.json(liveRow())
      if (path === '/api/attention') return Response.json([])
      if (path === '/api/saved-sessions') {
        return Response.json([{ id: ENDED, target: ENDED, workspace: '/home/you/old' }])
      }
      if (path === `/api/saved-sessions/${ENDED}/entries`) {
        return Response.json({ entries: [], cursor: '' })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })

    const user = userEvent.setup()
    renderHome()

    // the ended row navigates to its read-only transcript with a Resume button
    await user.click(await screen.findByText('~/old'))
    expect(await screen.findByRole('heading', { name: 'Ended session' })).toBeInTheDocument()
    expect(screen.getByTestId('resume-ended')).toBeInTheDocument()
  })

  it('resumes an ended session headlessly from its transcript', async () => {
    fetcher.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const path = String(url).split('?')[0]
      if (path === '/api/me')
        return Response.json({ username: 'you', via: 'cookie', home: '/home/you' })
      if (path === '/api/sessions' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({
          workspace: '/home/you/old',
          mode: 'resume',
          target: ENDED,
        })
        return Response.json({ sessionId: '01RESUMED000000000', pid: 42 })
      }
      if (path === '/api/sessions') return Response.json(liveRow())
      if (path === '/api/attention') return Response.json([])
      if (path === '/api/saved-sessions') {
        return Response.json([{ id: ENDED, target: ENDED, workspace: '/home/you/old' }])
      }
      if (path === `/api/saved-sessions/${ENDED}/entries`) {
        return Response.json({ entries: [], cursor: '' })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })

    const user = userEvent.setup()
    renderHome()

    await user.click(await screen.findByText('~/old'))
    await user.click(screen.getByTestId('resume-ended'))

    // the launch body rode the recorded workspace and resume target
    await vi.waitFor(() => {
      const launches = fetcher.mock.calls.filter(
        ([u, init]) => String(u) === '/api/sessions' && init?.method === 'POST',
      )
      expect(launches).toHaveLength(1)
    })
  })
})

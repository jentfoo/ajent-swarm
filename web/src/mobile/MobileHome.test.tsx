import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
// Pull-to-refresh re-reads both listings in place, past the touch threshold.

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
      if (path === '/api/models/options') return Response.json([])
      if (path === '/api/saved-sessions') return Response.json([])
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

  it('titles the tab after the launcher', async () => {
    renderHome()

    await screen.findByText('fix login flow')
    expect(document.title).toBe('Sessions · ajent-swarm')
  })

  it('lists live sessions by title with status badges', async () => {
    renderHome()

    // the stored swarm title wins over names and paths
    expect(await screen.findByText('fix login flow')).toBeInTheDocument()
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.getByText('ended')).toBeInTheDocument()
  })

  it('places the launch section above the session list', async () => {
    renderHome()

    const launch = await screen.findByRole('button', { name: 'Launch…' })
    const list = screen.getByLabelText('Live sessions')
    expect(launch.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows launcher sections for jobs and settings', async () => {
    renderHome()

    expect(await screen.findByTestId('link-jobs')).toHaveAttribute('href', '/jobs')
    expect(screen.getByTestId('link-settings')).toHaveAttribute('href', '/m/settings')

    // the launch form preselects the most recent workspace, the custom path
    // reveals on demand
    await userEvent.setup().click(screen.getByRole('button', { name: 'Launch…' }))
    expect(screen.getByLabelText('Working directory')).toHaveValue('/home/you/project')
    expect(screen.queryByTestId('custom-workspace')).not.toBeInTheDocument()
    await userEvent.setup().selectOptions(screen.getByLabelText('Working directory'), '')
    expect(screen.getByTestId('custom-workspace')).toBeInTheDocument()
  })

  it('launches new sessions under the most recent workspace', async () => {
    fetcher.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const path = String(url).split('?')[0]
      if (path === '/api/me')
        return Response.json({ username: 'you', via: 'cookie', home: '/home/you' })
      if (path === '/api/sessions' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({
          workspace: '/home/you/project',
          mode: 'new',
        })
        return Response.json({ sessionId: '01NEWSESSION0000000', pid: 7 })
      }
      if (path === '/api/sessions') return Response.json(liveRow())
      if (path === '/api/attention' || path === '/api/models/options') return Response.json([])
      if (path === '/api/saved-sessions') return Response.json([])
      throw new Error(`unexpected fetch ${String(url)}`)
    })

    renderHome()
    await screen.findByText('fix login flow')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Launch…' }))

    // the seed satisfies the workspace requirement without any user pick
    const launch = screen.getByTestId('launch-new')
    expect(launch).toBeEnabled()
    await user.click(launch)
    await vi.waitFor(() => {
      expect(
        fetcher.mock.calls.some(
          ([u, init]) => String(u) === '/api/sessions' && init?.method === 'POST',
        ),
      ).toBe(true)
    })
  })

  it('opens an ended row read-only transcript route', async () => {
    fetcher.mockImplementation(async (url: string | URL) => {
      const path = String(url).split('?')[0]
      if (path === '/api/me')
        return Response.json({ username: 'you', via: 'cookie', home: '/home/you' })
      if (path === '/api/sessions') return Response.json(liveRow())
      if (path === '/api/attention') return Response.json([])
      if (path === '/api/models/options') return Response.json([])
      if (path === '/api/saved-sessions') {
        return Response.json([{ id: ENDED, target: ENDED, workspace: '/home/you/old' }])
      }
      if (path === `/api/saved-sessions/${ENDED}/entries`) {
        return Response.json({ entries: [], cursor: '' })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })

    renderHome()

    // the ended row navigates to its read-only transcript with a Resume button
    // label and path line both read ~/old for an untitled session, so tap the
    // row element itself rather than either text node
    await screen.findAllByText('~/old')
    const user = userEvent.setup()
    await user.click(document.querySelector(`[data-session-id="${ENDED}"]`)!)
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
      if (path === '/api/models/options') return Response.json([])
      if (path === '/api/saved-sessions') {
        return Response.json([{ id: ENDED, target: ENDED, workspace: '/home/you/old' }])
      }
      if (path === `/api/saved-sessions/${ENDED}/entries`) {
        return Response.json({ entries: [], cursor: '' })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })

    // untitled rows repeat ~/old in label and path, so tap the row element
    renderHome()
    await screen.findAllByText('~/old')
    const user = userEvent.setup()
    await user.click(document.querySelector(`[data-session-id="${ENDED}"]`)!)
    await user.click(screen.getByTestId('resume-ended'))

    // the launch body rode the recorded workspace and resume target
    await vi.waitFor(() => {
      const launches = fetcher.mock.calls.filter(
        ([u, init]) => String(u) === '/api/sessions' && init?.method === 'POST',
      )
      expect(launches).toHaveLength(1)
    })
  })

  it('refreshes both listings on pull down', async () => {
    // the pull's saved re-read holds until released, so the refreshing state
    // is observable rather than a transient flash
    let savedCalls = 0
    let sessionCalls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    fetcher.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const path = String(url).split('?')[0]
      if (path === '/api/sessions' && init?.method === 'POST') {
        return Response.json({ sessionId: '01RESUMED000000000', pid: 42 })
      }
      if (path === '/api/me')
        return Response.json({ username: 'you', via: 'cookie', home: '/home/you' })
      if (path === '/api/sessions') {
        sessionCalls++
        return Response.json(liveRow())
      }
      if (path === '/api/attention') return Response.json([])
      if (path === '/api/models/options') return Response.json([])
      if (path === '/api/saved-sessions') {
        savedCalls++
        return savedCalls > 1 ? gate.then(() => Response.json([])) : Response.json([])
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })

    renderHome()
    await screen.findByText('fix login flow')
    expect(savedCalls).toBe(1) // the launcher's own mount read
    const sessionsBefore = sessionCalls

    const home = document.querySelector('.mobile-home') as HTMLElement
    fireEvent.touchStart(home, { touches: [{ clientY: 400 }] })
    fireEvent.touchMove(home, { touches: [{ clientY: 480 }] })
    fireEvent.touchEnd(home, { touches: [], changedTouches: [{ clientY: 480 }] })

    // both listings re-read immediately rather than waiting out a cadence
    await vi.waitFor(() => expect(savedCalls).toBe(2))
    expect(sessionCalls).toBeGreaterThan(sessionsBefore)
    expect(screen.getByText('Refreshing…')).toBeInTheDocument()

    // the status floats out of flow instead of opening a line above the
    // launcher, so its appearance cannot shift content beneath a gesture
    expect(screen.getByText('Refreshing…')).toHaveClass('pull-refresh')
    const launchSection = screen.getByLabelText('New session')
    expect(home.firstElementChild).toBe(launchSection)

    // role="status" announces the text alone, the arc glyph is decoration
    expect(screen.getByText('Refreshing…').firstElementChild).toHaveAttribute('aria-hidden', 'true')

    act(() => release())
    await waitFor(() => expect(screen.queryByText('Refreshing…')).not.toBeInTheDocument())
  })

  it('keeps short pulls from refreshing', async () => {
    renderHome()
    await screen.findByText('fix login flow')

    const savedCalls = () =>
      fetcher.mock.calls.filter(([u]) => String(u).endsWith('/api/saved-sessions')).length
    const before = savedCalls()

    const home = document.querySelector('.mobile-home') as HTMLElement
    fireEvent.touchStart(home, { touches: [{ clientY: 400 }] })
    fireEvent.touchMove(home, { touches: [{ clientY: 430 }] })
    fireEvent.touchEnd(home, { touches: [], changedTouches: [{ clientY: 430 }] })

    expect(savedCalls()).toBe(before)
  })
})

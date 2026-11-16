import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import EndedSessionScreen from './EndedSessionScreen'
import type { LaunchRequest, SavedSession } from '../api/types'

// Back control contract: warm in-app navigation keeps the history pop so list
// position and filters survive; cold entries (bookmark, saved link) have no
// entry behind them and fall back to a launcher link.

const ENDED = '01ENDEDSESSION00000'

function buildFetcher() {
  return vi.fn(async (url: string | URL) => {
    const path = String(url).split('?')[0]
    if (path === `/api/saved-sessions/${ENDED}/entries`)
      return Response.json({ entries: [], cursor: '' })
    throw new Error(`unexpected fetch ${String(url)}`)
  })
}

// OpenEnded drives MemoryRouter onto the read screen like a launcher row tap.
function OpenEnded({ replace }: { replace?: boolean }): ReactElement {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate(`/m/read/${ENDED}`, { replace })}>
      open ended
    </button>
  )
}

function ScreenRoutes(): ReactElement {
  return (
    <Routes>
      <Route path="/" element={<p>launcher</p>} />
      <Route path="/m/read/:sessionId" element={<EndedSessionScreen />} />
    </Routes>
  )
}

describe('EndedSessionScreen', () => {
  let fetcher: ReturnType<typeof buildFetcher>

  beforeEach(() => {
    fetcher = buildFetcher()
    vi.stubGlobal('fetch', fetcher)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('links to the launcher on cold entry', async () => {
    // lone initial entry carries react-router's 'default' key, like a bookmark
    render(
      <MemoryRouter initialEntries={[`/m/read/${ENDED}`]}>
        <ScreenRoutes />
      </MemoryRouter>,
    )

    const back = screen.getByRole('link', { name: '← Back' })
    expect(back).toHaveAttribute('href', '/')

    await userEvent.setup().click(back)
    expect(screen.getByText('launcher')).toBeInTheDocument()
  })

  it('pops history on warm navigation', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <OpenEnded />
        <ScreenRoutes />
      </MemoryRouter>,
    )

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'open ended' }))
    expect(await screen.findByRole('button', { name: '← Back' })).toBeInTheDocument()

    // the pop puts the launcher back in place
    await user.click(screen.getByRole('button', { name: '← Back' }))
    expect(screen.getByText('launcher')).toBeInTheDocument()
  })

  it('links to the launcher after a replace landing', async () => {
    // the login redirect rewrites history with replace, so the landing carries
    // a fresh key over an empty stack; navigation type must still spot it cold
    render(
      <MemoryRouter initialEntries={['/']}>
        <OpenEnded replace />
        <ScreenRoutes />
      </MemoryRouter>,
    )

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'open ended' }))
    expect(await screen.findByRole('link', { name: '← Back' })).toHaveAttribute('href', '/')

    await user.click(screen.getByRole('link', { name: '← Back' }))
    expect(screen.getByText('launcher')).toBeInTheDocument()
  })
})

// Resume contract: the launch passes the saved row's target, matching MobileHome
// and the SavedSession listing, whatever field identified the row.
describe('EndedSessionScreen resume', () => {
  const WORKSPACE = '/home/you/project'
  const RESUMED = '01RESUMED000000000'
  const NAME_TARGET = 'nightly run'

  // One saved row backs the listing; tests reshape it before rendering.
  let savedRow: SavedSession
  let launches: LaunchRequest[]

  // baseRow completes the wire shape with id and target coinciding, the
  // common unnamed case
  function baseRow(): SavedSession {
    return {
      id: ENDED,
      target: ENDED,
      workspace: WORKSPACE,
      updatedMs: 0,
      messages: 1,
      blocked: false,
      live: false,
    }
  }

  beforeEach(() => {
    savedRow = baseRow()
    launches = []
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const path = String(url).split('?')[0]
      if (path === '/api/saved-sessions') return Response.json([savedRow])
      if (path === `/api/saved-sessions/${ENDED}/entries`)
        return Response.json({ entries: [], cursor: '' })
      if (path === '/api/sessions' && init?.method === 'POST') {
        launches.push(JSON.parse(String(init.body)))
        return Response.json({ sessionId: RESUMED, pid: 42 })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function renderRead() {
    render(
      <MemoryRouter initialEntries={[`/m/read/${ENDED}`]}>
        <Routes>
          <Route path="/" element={<p>launcher</p>} />
          <Route path="/m/read/:sessionId" element={<EndedSessionScreen />} />
          <Route path="/s/:sessionId" element={<p>live session</p>} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('passes the row target for a named row', async () => {
    // opened by id, the launch still rides the listing's target
    savedRow = { ...baseRow(), name: NAME_TARGET, target: NAME_TARGET }
    const user = userEvent.setup()
    renderRead()

    await user.click(screen.getByTestId('resume-ended'))

    expect(await screen.findByText('live session')).toBeInTheDocument()
    expect(launches).toEqual([{ workspace: WORKSPACE, mode: 'resume', target: NAME_TARGET }])
  })

  it('keeps the id target when name and id coincide', async () => {
    const user = userEvent.setup()
    renderRead()

    await user.click(screen.getByTestId('resume-ended'))

    expect(await screen.findByText('live session')).toBeInTheDocument()
    expect(launches).toEqual([{ workspace: WORKSPACE, mode: 'resume', target: ENDED }])
  })

  it('surfaces a row without a recorded workspace', async () => {
    savedRow = { ...baseRow(), workspace: undefined }
    const user = userEvent.setup()
    renderRead()

    await user.click(screen.getByTestId('resume-ended'))

    expect(await screen.findByText(/launch manually/)).toBeInTheDocument()
    expect(launches).toEqual([])
  })
})

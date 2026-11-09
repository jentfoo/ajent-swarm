import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import EndedSessionScreen from './EndedSessionScreen'

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

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SeatBadge } from './SeatBadge'

const VIEW = '01SEATBADGETEST01'

function held(holder: string | undefined) {
  return { held: true, holder, yours: false }
}

describe('SeatBadge', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hides itself while the seat is free or already ours', () => {
    const free = render(<SeatBadge sessionId={VIEW} seat={{ held: false, yours: false }} />)
    expect(free.container).toBeEmptyDOMElement()

    const ours = render(
      <SeatBadge sessionId={VIEW} seat={{ held: true, holder: 'swarm', yours: true }} />,
    )
    expect(ours.container).toBeEmptyDOMElement()
  })

  it('labels the holder and claims control through take-control', async () => {
    let unblock = (): void => {}
    const gate = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const handler = vi.fn((_url: string | URL, _init?: RequestInit): Promise<Response> =>
      gate.then(() => Response.json({}, { status: 200 })),
    )
    vi.stubGlobal('fetch', handler)

    render(<SeatBadge sessionId={VIEW} seat={held('swarm')} />)
    const button = screen.getByRole('button', { name: 'take control: swarm' })
    expect(button).toHaveAttribute('title', 'Take control from swarm')

    // the claim is in flight only once and blocks re-clicks while it runs
    await userEvent.setup().click(button)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'take control: swarm' })).toBeDisabled()

    unblock()
    await waitFor(() => expect(button).not.toBeDisabled())

    const [url, init] = handler.mock.calls[0]!
    expect(String(url)).toBe(`/api/sessions/${VIEW}/take-control`)
    expect(init?.method).toBe('POST')
  })

  it('keeps showing the holder after a refused claim', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Response.json({ error: 'busy', message: 'holder active' }, { status: 409 })),
    )
    render(<SeatBadge sessionId={VIEW} seat={held('swarm')} />)

    await userEvent.setup().click(screen.getByRole('button', { name: 'take control: swarm' }))

    // the badge stays contested and re-enables; the next snapshot updates it
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'take control: swarm' })).not.toBeDisabled(),
    )
  })

  it('keeps the compact label for a holderless seat', () => {
    render(<SeatBadge sessionId={VIEW} seat={held(undefined)} compact />)
    expect(screen.getByRole('button', { name: 'seat held' })).toBeInTheDocument()
  })
})

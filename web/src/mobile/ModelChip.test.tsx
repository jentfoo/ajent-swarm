import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ModelChip } from './ModelChip'
import type { CtlState } from '../api/types'

// The compact header model control over the shared useModelMenu controller:
// one fetch per open filling the shared grouped items, model.set switching
// without a picker, and refusals surfacing as toasts.

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })

const snap: CtlState = {
  session: { id: '01S' },
  workspace: '/w',
  cwd: '/w',
  head: '',
  model: {
    key: 'anthropic/claude-sonnet',
    short: 'sonnet',
    window: 0,
    caps: { reasoning: false, images: false, parallelToolCalls: false },
  },
  permission: '',
  tools: [],
  usage: { turns: 0, total: zeroUsage(), child: zeroUsage(), estimatedTurns: 0 },
  context: { used: 0, window: 0, reserve: 0, compact: 0, estimated: false },
  running: false,
  idle: true,
  spinning: false,
  queued: 0,
  activity: [],
  status: {},
  seat: { held: false, yours: false },
}

function stubFetch(respond: (url: string, init?: RequestInit) => Response) {
  const spy = vi.fn(async (url: string | URL, init?: RequestInit) =>
    respond(String(url).replace(/^https?:\/\/[^/]+/, ''), init),
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

describe('ModelChip', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists the registry grouped and marks the active model', async () => {
    const user = userEvent.setup()
    stubFetch((url) => {
      if (url === '/api/sessions/01S/models') {
        return Response.json({
          active: 'anthropic/claude-sonnet',
          models: [
            { key: 'anthropic/claude-sonnet', short: 'sonnet' },
            { key: 'anthropic/claude-haiku', short: 'haiku' },
            { key: 'local-tuned', short: '' },
          ],
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    })

    render(<ModelChip sessionId="01S" snap={snap} onToast={() => {}} />)
    await user.click(screen.getByRole('button', { name: /sonnet/ }))

    const items = await screen.findAllByRole('menuitem')
    expect(items.map((el) => el.textContent?.replace(/\s*current$/, ''))).toEqual([
      'sonnet',
      'haiku',
      'local-tuned',
    ])
    expect(screen.getByRole('group', { name: 'anthropic' })).toBeInTheDocument()
    expect(items.filter((el) => el.textContent?.includes('current'))).toHaveLength(1)
  })

  it('fetches the listing once per open, never on dependency drift', async () => {
    const user = userEvent.setup()
    stubFetch((url) => {
      if (url === '/api/sessions/01S/models') {
        return Response.json({
          active: 'anthropic/claude-sonnet',
          models: [{ key: 'anthropic/claude-sonnet', short: 'sonnet' }],
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    })

    const view = render(<ModelChip sessionId="01S" snap={snap} onToast={() => {}} />)
    await user.click(screen.getByRole('button', { name: /sonnet/ }))
    await screen.findByRole('menuitem')

    // the stream announcing a different model key must not refetch while open
    const drifted = {
      ...snap,
      model: { ...snap.model, key: 'anthropic/claude-haiku', short: 'haiku' },
    }
    view.rerender(<ModelChip sessionId="01S" snap={drifted} onToast={() => {}} />)
    await act(async () => {}) // flush any wrongly scheduled effect
    expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith('/models'))).toHaveLength(
      1,
    )

    // reopening does list fresh, exactly like the desktop header menu
    fireEvent.pointerDown(document.body) // outside the menu closes it
    await user.click(screen.getByTitle('Switch model'))
    await screen.findByRole('menuitem')
    expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith('/models'))).toHaveLength(
      2,
    )
  })

  it('switches through model.set and closes the menu', async () => {
    const user = userEvent.setup()
    const spy = stubFetch((url, init) => {
      if (url === '/api/sessions/01S/models') {
        return Response.json({
          active: 'anthropic/claude-sonnet',
          models: [{ key: 'anthropic/claude-sonnet', short: 'sonnet' }, { key: 'h' }],
        })
      }
      if (url === '/api/sessions/01S/model') {
        expect(JSON.parse(String(init?.body))).toEqual({ model: 'h' })
        return Response.json({ model: 'h' })
      }
      throw new Error(`unexpected fetch ${url}`)
    })

    render(<ModelChip sessionId="01S" snap={snap} onToast={() => {}} />)
    await user.click(screen.getByRole('button', { name: /sonnet/ }))
    await user.click(await screen.findByRole('menuitem', { name: 'h' }))

    await vi.waitFor(() => {
      expect(spy.mock.calls.some(([u]) => String(u).endsWith('/model'))).toBe(true)
    })
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })

  it('toasts a listing refusal and never opens the menu', async () => {
    const user = userEvent.setup()
    const onToast = vi.fn()
    stubFetch((url) => {
      if (url === '/api/sessions/01S/models') {
        return Response.json(
          { error: 'seat_held', message: 'another controller holds the seat' },
          { status: 409 },
        )
      }
      throw new Error(`unexpected fetch ${url}`)
    })

    render(<ModelChip sessionId="01S" snap={snap} onToast={onToast} />)
    await user.click(screen.getByRole('button', { name: /sonnet/ }))

    await vi.waitFor(() => {
      expect(onToast).toHaveBeenCalledWith('seat_held: another controller holds the seat', 'error')
    })
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })

  it('dismisses on an outside tap', async () => {
    const user = userEvent.setup()
    stubFetch((url) => {
      if (url === '/api/sessions/01S/models') {
        return Response.json({ active: 'anthropic/claude-sonnet', models: [{ key: 'h' }] })
      }
      throw new Error(`unexpected fetch ${url}`)
    })

    render(<ModelChip sessionId="01S" snap={snap} onToast={() => {}} />)
    await user.click(screen.getByRole('button', { name: /sonnet/ }))
    expect(await screen.findByRole('menu')).toBeInTheDocument()

    fireEvent.pointerDown(document.body) // anywhere outside the chip and menu
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

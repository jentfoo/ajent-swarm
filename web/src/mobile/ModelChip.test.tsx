import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ModelChip } from './ModelChip'
import type { CtlState } from '../api/types'

// The compact header model control: models.get fills the menu through the
// shared grouped items, model.set switches without a picker, refusals surface
// as toasts, and the listing only ever renders for its own session.

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

  it('toasts a refusal without losing the menu', async () => {
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

    fireEvent.mouseDown(document.body) // anywhere outside the chip and menu
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('drops a listing that lands after the menu closed', async () => {
    const user = userEvent.setup()
    const onToast = vi.fn()
    let resolveModels!: (res: Response) => void
    const spy = vi.fn(
      () =>
        new Promise<Response>((res) => {
          resolveModels = res
        }),
    )
    vi.stubGlobal('fetch', spy)

    render(<ModelChip sessionId="01S" snap={snap} onToast={onToast} />)
    await user.click(screen.getByRole('button', { name: /sonnet/ })) // open; listing flies
    expect(spy).toHaveBeenCalledTimes(1)

    fireEvent.mouseDown(document.body) // close before the reply lands

    await act(async () => {
      resolveModels(Response.json({ active: 'x', models: [{ key: 'x' }] }))
    })

    // the stale cycle reopens nothing and reports nothing
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(onToast).not.toHaveBeenCalled()
  })

  it('hides a listing that belongs to another session', async () => {
    const user = userEvent.setup()
    stubFetch((url) => {
      if (url === '/api/sessions/01S/models') {
        return Response.json({ active: 'other', models: [{ key: 'x', short: '' }] })
      }
      throw new Error(`unexpected fetch ${url}`)
    })

    const view = render(<ModelChip sessionId="01S" snap={snap} onToast={() => {}} />)
    await user.click(screen.getByRole('button', { name: /sonnet/ }))
    expect(await screen.findByRole('menuitem', { name: 'x' })).toBeInTheDocument()

    // the host reuses this chip for another session: 01S's registry must go
    view.rerender(<ModelChip sessionId="02S" snap={snap} onToast={() => {}} />)
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })

  it('drops a listing that lands after a session swap', async () => {
    const user = userEvent.setup()
    const onToast = vi.fn()
    const resolvers: ((res: Response) => void)[] = []
    const spy = vi.fn(
      () =>
        new Promise<Response>((res) => {
          resolvers.push(res)
        }),
    )
    vi.stubGlobal('fetch', spy)

    const view = render(<ModelChip sessionId="01S" snap={snap} onToast={onToast} />)
    await user.click(screen.getByRole('button', { name: /sonnet/ })) // open; listing flies
    view.rerender(<ModelChip sessionId="02S" snap={snap} onToast={onToast} />)

    await act(async () => {
      resolvers[0]!(Response.json({ active: 'x', models: [{ key: 'x' }] }))
    })

    // 01S's late reply belongs to a session no longer mounted here
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
    expect(onToast).not.toHaveBeenCalled()
  })
})

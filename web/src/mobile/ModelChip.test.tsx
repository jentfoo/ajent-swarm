import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ModelChip } from './ModelChip'
import type { CtlState } from '../api/types'

// The compact header model control: models.get fills the menu, model.set
// switches without a picker, and refusals surface as toasts.

const snap = { model: { key: 'anthropic/claude-sonnet', short: 'sonnet' } } as CtlState

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

  it('lists the registry and marks the active model', async () => {
    const user = userEvent.setup()
    stubFetch((url) => {
      if (url === '/api/sessions/01S/models') {
        return Response.json({
          active: 'anthropic/claude-sonnet',
          models: [
            { key: 'anthropic/claude-sonnet', short: 'sonnet' },
            { key: 'anthropic/claude-haiku', short: 'haiku' },
          ],
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    })

    render(<ModelChip sessionId="01S" snap={snap} onToast={() => {}} />)
    await user.click(screen.getByRole('button', { name: /sonnet/ }))

    const items = await screen.findAllByRole('menuitem')
    expect(items).toHaveLength(2)
    expect(screen.getByText('anthropic/claude-sonnet')).toBeInTheDocument()
    expect(screen.getByText('current')).toBeInTheDocument()
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
})

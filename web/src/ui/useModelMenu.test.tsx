import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ModelMenuItems } from './ModelMenuItems'
import { useModelMenu } from './useModelMenu'

// The model registry controller both chat headers share: one fetch per open,
// model.set picks, and toasts on refusals. Hosts key on sessionId, so a swap
// remounts and session hygiene lives there, not in the hook. The open body is
// the real ModelMenuItems, so the filter's remount lifecycle lands here too.

function MenuProbe({
  sessionId,
  fallbackKey,
  onToast,
}: {
  sessionId: string
  fallbackKey: string
  onToast: (text: string, level?: 'info' | 'error') => void
}) {
  const menu = useModelMenu(sessionId, fallbackKey, onToast)
  return (
    <div>
      <span data-testid="open">{String(menu.open)}</span>
      <span data-testid="busy">{String(menu.busy)}</span>
      <span data-testid="active">{menu.active}</span>
      <button type="button" onClick={() => void menu.toggle()}>
        toggle
      </button>
      <button type="button" onClick={() => menu.close()}>
        close
      </button>
      <button type="button" onClick={() => void menu.pick('other/model')}>
        pick
      </button>
      {menu.open && (
        <ModelMenuItems
          models={menu.models}
          active={menu.active}
          currentKey=""
          onPick={(key) => void menu.pick(key)}
        />
      )}
    </div>
  )
}

function stubFetch(respond: (url: string) => Response | Promise<Response>) {
  const spy = vi.fn(async (url: string | URL) =>
    respond(String(url).replace(/^https?:\/\/[^/]+/, '')),
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

describe('useModelMenu', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const listing = () => Response.json({ active: 'a/m', models: [{ key: 'a/m', short: 'm' }] })

  it('fetches once per open and stays quiet on dependency drift', async () => {
    const user = userEvent.setup()
    stubFetch((url) => {
      if (url === '/api/sessions/01S/models') return listing()
      throw new Error(`unexpected fetch ${url}`)
    })
    const onToast = vi.fn()
    const view = render(<MenuProbe sessionId="01S" fallbackKey="x" onToast={onToast} />)

    // open: one fetch, then the menu opens with the reply's active key
    await user.click(screen.getByRole('button', { name: 'toggle' }))
    expect(await screen.findByRole('menuitem', { name: /^m/ })).toBeInTheDocument()
    expect(screen.getByTestId('open')).toHaveTextContent('true')
    expect(screen.getByTestId('active')).toHaveTextContent('a/m')
    expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith('/models'))).toHaveLength(
      1,
    )

    // a rerendered fallback key must not refetch while open
    view.rerender(<MenuProbe sessionId="01S" fallbackKey="y" onToast={onToast} />)
    await act(async () => {}) // flush any wrongly scheduled effect
    expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith('/models'))).toHaveLength(
      1,
    )

    // close then reopen: a fresh fetch per open
    await user.click(screen.getByRole('button', { name: 'toggle' }))
    expect(screen.getByTestId('open')).toHaveTextContent('false')
    await user.click(screen.getByRole('button', { name: 'toggle' }))
    await screen.findByRole('menuitem', { name: /^m/ })
    expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith('/models'))).toHaveLength(
      2,
    )
  })

  it('falls back to the snapshot key when the listing omits active', async () => {
    const user = userEvent.setup()
    stubFetch((url) => {
      if (url === '/api/sessions/01S/models') {
        return Response.json({ active: '', models: [{ key: 'a/m', short: 'm' }] })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    render(<MenuProbe sessionId="01S" fallbackKey="snap/key" onToast={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'toggle' }))
    expect(await screen.findByRole('menuitem', { name: /^m/ })).toBeInTheDocument()
    expect(screen.getByTestId('active')).toHaveTextContent('snap/key')
  })

  it('toasts a listing refusal and keeps the menu closed', async () => {
    const user = userEvent.setup()
    stubFetch((url) => {
      if (url === '/api/sessions/01S/models') {
        return Response.json({ error: 'seat_held', message: 'held' }, { status: 409 })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const onToast = vi.fn()
    render(<MenuProbe sessionId="01S" fallbackKey="x" onToast={onToast} />)

    await user.click(screen.getByRole('button', { name: 'toggle' }))

    await vi.waitFor(() => expect(onToast).toHaveBeenCalledWith('held', 'error'))
    expect(screen.getByTestId('open')).toHaveTextContent('false')
  })

  it('picks through model.set and closes only on success', async () => {
    const user = userEvent.setup()
    stubFetch((url) => {
      if (url === '/api/sessions/01S/models') return listing()
      if (url === '/api/sessions/01S/model') {
        return Response.json(
          { error: 'ambiguous', message: 'two providers match' },
          { status: 400 },
        )
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    const onToast = vi.fn()
    render(<MenuProbe sessionId="01S" fallbackKey="x" onToast={onToast} />)

    await user.click(screen.getByRole('button', { name: 'toggle' }))
    await screen.findByRole('menuitem', { name: /^m/ })

    // a refused pick keeps the menu open for another choice
    await user.click(screen.getByRole('button', { name: 'pick' }))
    await vi.waitFor(() => expect(onToast).toHaveBeenCalledWith('two providers match', 'error'))
    expect(screen.getByTestId('open')).toHaveTextContent('true')
  })

  it('resets the filter query when the menu reopens', async () => {
    const user = userEvent.setup()
    stubFetch((url) => {
      if (url === '/api/sessions/01S/models') {
        return Response.json({
          active: 'a/m',
          models: [
            { key: 'a/m', short: 'm' },
            { key: 'a/other', short: 'other' },
          ],
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    render(<MenuProbe sessionId="01S" fallbackKey="x" onToast={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'toggle' }))
    const filter = await screen.findByRole('searchbox')
    await user.type(filter, 'other')
    expect(screen.queryByRole('menuitem', { name: /^m/ })).not.toBeInTheDocument()

    // the body unmounts on close, so the query dies with it
    await user.click(screen.getByRole('button', { name: 'toggle' }))
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'toggle' }))
    expect(await screen.findByRole('searchbox')).toHaveValue('')
    expect(screen.getByRole('menuitem', { name: /^m/ })).toBeInTheDocument()
  })
})

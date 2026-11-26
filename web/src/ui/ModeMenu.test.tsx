import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ModeMenu } from './ModeMenu'
import { stubCoarsePointer } from '../test/matchMedia'

// The permission mode chip: the fixed upstream vocabulary as one single-select
// menu, the current mode the checked radio, mode.set switching without a
// picker, refusals surfacing as toasts. Either pointer branch names the menu,
// and the touch branch peels alone on the platform back gesture.

const SESSION = '01MODESESSION00000'

function stubFetch(respond: (url: string, init?: RequestInit) => Response) {
  const spy = vi.fn(async (url: string | URL, init?: RequestInit) =>
    respond(String(url).replace(/^https?:\/\/[^/]+/, ''), init),
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

const acceptAll = (url: string, init?: RequestInit): Response => {
  if (url === `/api/sessions/${SESSION}/mode` && init?.method === 'POST') {
    return Response.json({ mode: JSON.parse(String(init.body)).mode })
  }
  throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`)
}

// radios lists the open menu's items as [text, aria-checked] pairs
const radios = () =>
  screen
    .getAllByRole('menuitemradio')
    .map((el) => [el.textContent, el.getAttribute('aria-checked')])

describe('ModeMenu', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders nothing without a gate', () => {
    render(<ModeMenu sessionId={SESSION} mode="" onToast={() => {}} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('announces the chip as a toggleable menu', async () => {
    const user = userEvent.setup()
    render(<ModeMenu sessionId={SESSION} mode="auto" onToast={() => {}} />)

    const chip = screen.getByRole('button', { name: 'mode: auto' })
    expect(chip).toHaveAttribute('aria-haspopup', 'menu')
    expect(chip).toHaveAttribute('aria-expanded', 'false')

    await user.click(chip)
    expect(chip).toHaveAttribute('aria-expanded', 'true')

    await user.click(chip)
    expect(chip).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('lists the vocabulary as radios, the current mode checked', async () => {
    stubFetch(acceptAll)
    const user = userEvent.setup()
    render(<ModeMenu sessionId={SESSION} mode="auto" onToast={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'mode: auto' }))
    // the menu carries its own name, a popup never inherits the chip's
    expect(await screen.findByRole('menu', { name: 'Permission mode' })).toBeInTheDocument()
    expect(radios()).toEqual([
      ['allow-read', 'false'],
      ['autocurrent', 'true'],
      ['auto+write', 'false'],
      ['allow-all', 'false'],
      ['block-all', 'false'],
    ])
    // the badge stays the visual twin, the checked state is the semantic one
    expect(screen.getByRole('menuitemradio', { name: 'autocurrent' })).toBeChecked()
    expect(screen.getAllByRole('menuitemradio', { checked: true })).toHaveLength(1)
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })

  it('sets a named level through the mode endpoint and closes', async () => {
    const spy = stubFetch(acceptAll)
    const onToast = vi.fn()
    const user = userEvent.setup()
    render(<ModeMenu sessionId={SESSION} mode="auto" onToast={onToast} />)
    await user.click(screen.getByRole('button', { name: 'mode: auto' }))
    await screen.findByRole('menu', { name: 'Permission mode' })

    await user.click(screen.getByRole('menuitemradio', { name: 'allow-all' }))

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toContain(`/api/sessions/${SESSION}/mode`)
    expect(JSON.parse(String(init?.body))).toEqual({ mode: 'allow-all' })
    expect(onToast).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

  it('closes without a request when the current mode is picked again', async () => {
    const spy = stubFetch(acceptAll)
    const user = userEvent.setup()
    render(<ModeMenu sessionId={SESSION} mode="auto" onToast={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'mode: auto' }))
    await screen.findByRole('menu', { name: 'Permission mode' })

    await user.click(screen.getByRole('menuitemradio', { name: 'autocurrent' }))

    expect(spy).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

  it('surfaces a refusal as a toast and keeps the menu open', async () => {
    const onToast = vi.fn()
    stubFetch((url, init) => {
      if (url === `/api/sessions/${SESSION}/mode` && init?.method === 'POST') {
        return Response.json(
          { error: 'invalid_request', message: 'no gate on this session' },
          { status: 400 },
        )
      }
      throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`)
    })
    const user = userEvent.setup()
    render(<ModeMenu sessionId={SESSION} mode="auto" onToast={onToast} />)
    await user.click(screen.getByRole('button', { name: 'mode: auto' }))
    await screen.findByRole('menu', { name: 'Permission mode' })

    await user.click(screen.getByRole('menuitemradio', { name: 'block-all' }))

    await waitFor(() => expect(onToast).toHaveBeenCalledWith('no gate on this session', 'error'))
    expect(screen.getByRole('menu', { name: 'Permission mode' })).toBeInTheDocument()
  })

  it('names the touch menu and closes it on platform back', async () => {
    // the coarse-pointer branch rides OverlayMenu: the name, the checked radio
    // and the history-bound close must all hold there too
    stubCoarsePointer()
    stubFetch(acceptAll)
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    try {
      const user = userEvent.setup()
      render(<ModeMenu sessionId={SESSION} mode="auto+write" onToast={() => {}} />)

      await user.click(screen.getByRole('button', { name: 'mode: auto+write' }))
      expect(await screen.findByRole('menu', { name: 'Permission mode' })).toBeInTheDocument()
      expect(screen.getByRole('menuitemradio', { name: 'auto+writecurrent' })).toBeChecked()

      // the platform back gesture pops the menu's own history entry and closes it
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'))
      })
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      expect(back).toHaveBeenCalledTimes(1) // its own entry, not a router one
    } finally {
      back.mockRestore()
    }

    // settle the queued consume and leave unstamped ground behind
    window.dispatchEvent(new PopStateEvent('popstate'))
    window.history.replaceState(null, '', window.location.href)
  })
})

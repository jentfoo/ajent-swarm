import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ModelMenu } from './ModelMenu'
import type { CtlState } from '../api/types'
import { stubCoarsePointer } from '../test/matchMedia'

// The one model menu both chat headers render, over the shared useModelMenu
// controller: one fetch per open filling the shared grouped items, model.set
// switching without a picker, refusals surfacing as toasts, and the pointer
// class picking OverlayMenu against MenuPopover exactly like ModeMenu. The
// filter rides the popover's header slot outside the menu role on both branches.

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })

function snapFor(overrides: Partial<CtlState['model']> = {}): CtlState {
  return {
    session: { id: '01S' },
    workspace: '/w',
    cwd: '/w',
    head: '',
    model: {
      key: 'anthropic/claude-sonnet',
      short: 'sonnet',
      window: 0,
      caps: { reasoning: false, images: false, parallelToolCalls: false },
      ...overrides,
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
}

function stubFetch(respond: (url: string, init?: RequestInit) => Response) {
  const spy = vi.fn(async (url: string | URL, init?: RequestInit) =>
    respond(String(url).replace(/^https?:\/\/[^/]+/, ''), init),
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

describe('ModelMenu', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // the setup's matchMedia stand-in answers nothing, so tests render the
  // fine-pointer branch unless they stub the coarse class
  it('renders the plain popover branch for fine pointers', async () => {
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

    render(<ModelMenu sessionId="01S" snap={snapFor()} onToast={() => {}} />)
    expect(document.querySelector('.model-menu')).toBeInTheDocument()
    expect(document.querySelector('.model-chip-wrap')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /sonnet/ }))
    expect(await screen.findByRole('menu', { name: 'Models' })).toBeInTheDocument()
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

    render(<ModelMenu sessionId="01S" snap={snapFor()} onToast={() => {}} />)
    await user.click(screen.getByRole('button', { name: /sonnet/ }))

    const items = await screen.findAllByRole('menuitemradio')
    expect(items.map((el) => el.textContent?.replace(/\s*current$/, ''))).toEqual([
      'sonnet',
      'haiku',
      'local-tuned',
    ])
    expect(screen.getByRole('group', { name: 'anthropic' })).toBeInTheDocument()
    expect(items.filter((el) => el.textContent?.includes('current'))).toHaveLength(1)
    // the active model is the one checked radio, the badge its visual twin
    expect(screen.getByRole('menuitemradio', { name: /^sonnet/ })).toBeChecked()
    expect(screen.getAllByRole('menuitemradio', { checked: true })).toHaveLength(1)
  })

  it('keeps the filter input outside the menu role', async () => {
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

    render(<ModelMenu sessionId="01S" snap={snapFor()} onToast={() => {}} />)
    await user.click(screen.getByRole('button', { name: /sonnet/ }))
    const menu = await screen.findByRole('menu', { name: 'Models' })

    // the filter row rides the layer above the role element, so the menu's
    // children are items only
    const filter = screen.getByRole('searchbox', { name: 'Filter models' })
    expect(menu).not.toContainElement(filter)
    expect(menu.parentElement).toContainElement(filter)
    expect(menu.querySelector('input')).toBeNull()
  })

  it('narrows the rows from the header filter', async () => {
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

    render(<ModelMenu sessionId="01S" snap={snapFor()} onToast={() => {}} />)
    // a keyboard open autofocuses the header filter without stealing into items
    await user.tab()
    await user.keyboard('{Enter}')
    const filter = await screen.findByRole('searchbox', { name: 'Filter models' })
    expect(filter).toHaveFocus()
    expect(screen.getAllByRole('menuitemradio').map((el) => el.textContent)).toEqual([
      'sonnetcurrent',
      'haiku',
    ])

    await user.type(filter, 'haiku')
    expect(screen.getAllByRole('menuitemradio').map((el) => el.textContent)).toEqual(['haiku'])
    // the caret keeps its own keys while the rows narrow underneath it
    expect(filter).toHaveFocus()
  })

  it('starts every open with a blank filter', async () => {
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

    render(<ModelMenu sessionId="01S" snap={snapFor()} onToast={() => {}} />)
    await user.click(screen.getByRole('button', { name: /sonnet/ }))
    await user.type(await screen.findByRole('searchbox', { name: 'Filter models' }), 'haiku')
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(1)

    // close, then reopen: the fresh visit lists everything again
    fireEvent.pointerDown(document.body)
    await user.click(screen.getByRole('button', { name: /sonnet/ }))
    expect(await screen.findByRole('searchbox', { name: 'Filter models' })).toHaveValue('')
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2)
  })

  it('drops the filter row while nothing lists', async () => {
    const user = userEvent.setup()
    stubFetch((url) => {
      if (url === '/api/sessions/01S/models') return Response.json({ active: '', models: [] })
      throw new Error(`unexpected fetch ${url}`)
    })

    render(<ModelMenu sessionId="01S" snap={snapFor()} onToast={() => {}} />)
    await user.click(screen.getByRole('button', { name: /sonnet/ }))

    expect(await screen.findByRole('menu', { name: 'Models' })).toHaveTextContent(
      'No models listed.',
    )
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
  })

  it('announces the trigger as a toggleable menu', async () => {
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

    render(<ModelMenu sessionId="01S" snap={snapFor()} onToast={() => {}} />)

    const chip = screen.getByRole('button', { name: /sonnet/ })
    expect(chip).toHaveAttribute('aria-haspopup', 'menu')
    expect(chip).toHaveAttribute('aria-expanded', 'false')

    await user.click(chip)
    await screen.findByRole('menuitemradio')
    expect(chip).toHaveAttribute('aria-expanded', 'true')
  })

  it('labels the chip from the snapshot model', () => {
    stubFetch(() => {
      throw new Error('unexpected fetch')
    })

    const { rerender } = render(<ModelMenu sessionId="01S" snap={snapFor()} onToast={() => {}} />)
    expect(screen.getByRole('button', { name: /sonnet/ })).toBeInTheDocument()

    // a snapshot without a short or key falls back to the bare word
    rerender(
      <ModelMenu sessionId="01S" snap={snapFor({ key: '', short: '' })} onToast={() => {}} />,
    )
    expect(screen.getByRole('button', { name: 'model' })).toBeInTheDocument()
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

    render(<ModelMenu sessionId="01S" snap={snapFor()} onToast={() => {}} />)
    await user.click(screen.getByRole('button', { name: /sonnet/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'h' }))

    await vi.waitFor(() => {
      expect(spy.mock.calls.some(([u]) => String(u).endsWith('/model'))).toBe(true)
    })
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument()
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

    render(<ModelMenu sessionId="01S" snap={snapFor()} onToast={onToast} />)
    await user.click(screen.getByRole('button', { name: /sonnet/ }))

    await vi.waitFor(() => {
      expect(onToast).toHaveBeenCalledWith('another controller holds the seat', 'error')
    })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes on platform back for touch pointers', async () => {
    // the history-bound popover mounts only here. Fine-pointer tests above
    // run with the setup's matchMedia stub and keep desktop's plain MenuPopover
    stubCoarsePointer()
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    try {
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

      render(<ModelMenu sessionId="01S" snap={snapFor()} onToast={() => {}} />)
      expect(document.querySelector('.model-chip-wrap')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: /sonnet/ }))
      // the touch branch names its menu and checks its active row the same way
      expect(await screen.findByRole('menu', { name: 'Models' })).toBeInTheDocument()
      expect(screen.getByRole('menuitemradio', { name: /^sonnet/ })).toBeChecked()

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

  it('opens the touch menu without summoning the keyboard', async () => {
    // the coarse-pointer branch renders through OverlayMenu, and its filter
    // must not grab the caret: that would bounce the software keyboard open
    // on every menu open. Tapping Filter models stays deliberate.
    stubCoarsePointer()
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

    render(<ModelMenu sessionId="01S" snap={snapFor()} onToast={() => {}} />)
    await user.click(screen.getByRole('button', { name: /sonnet/ }))
    expect(await screen.findByRole('menuitemradio', { name: /^sonnet/ })).toBeInTheDocument()
    // the filter rides outside the menu role on this branch too
    expect(screen.getByRole('menu', { name: 'Models' })).not.toContainElement(
      screen.getByRole('searchbox'),
    )
    expect(screen.getByRole('searchbox')).not.toHaveFocus()

    // settle the queued consume and leave unstamped ground behind, like the
    // platform-back test; act wraps the close the popstate drives
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    window.history.replaceState(null, '', window.location.href)
  })

  it('fetches the listing fresh on each open', async () => {
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

    render(<ModelMenu sessionId="01S" snap={snapFor()} onToast={() => {}} />)
    await user.click(screen.getByRole('button', { name: /sonnet/ }))
    await screen.findByRole('menuitemradio')

    fireEvent.pointerDown(document.body) // outside the menu closes it
    await user.click(screen.getByTitle('Switch model'))
    await screen.findByRole('menuitemradio')
    expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith('/models'))).toHaveLength(
      2,
    )
  })
})

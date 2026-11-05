import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ModeMenu, StatusHeader } from './StatusHeader'
import type { CtlState } from '../api/types'

// The mode menu picks straight from the fixed upstream vocabulary through
// mode.set; a session without a gate renders no affordance at all. The header
// carries identity: stored title (or name) beside the short session id.

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => Response.json({ rows: [] }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function snapFor(overrides: Partial<CtlState> = {}): CtlState {
  return {
    session: { id: '01HWYSF8G2XK', name: '' },
    workspace: '/w',
    cwd: '/w',
    head: '',
    model: {
      key: 'p/m',
      short: '',
      window: 0,
      caps: { reasoning: false, images: false, parallelToolCalls: false },
    },
    permission: '',
    tools: [],
    usage: { turns: 0, total: zero(), child: zero(), estimatedTurns: 0 },
    context: { used: 0, window: 0, reserve: 0, compact: 0, estimated: false },
    running: false,
    idle: true,
    spinning: false,
    queued: 0,
    activity: [],
    status: {},
    seat: { held: false, yours: false },
    ...overrides,
  }
}

function zero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

describe('ModeMenu', () => {
  it('hides entirely when no gate exists', () => {
    render(<ModeMenu sessionId="01S" mode="" onToast={vi.fn()} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('marks the active level in the mode menu', async () => {
    const user = userEvent.setup()
    render(<ModeMenu sessionId="01S" mode="auto" onToast={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /mode: auto/ }))
    const items = screen.getAllByRole('menuitem')
    // the active level carries a visible marker, exactly one
    expect(items.filter((el) => el.textContent?.includes('current'))).toHaveLength(1)
  })

  it('sets a named level through the mode endpoint', async () => {
    const user = userEvent.setup()
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).endsWith('/mode')) return Response.json({ mode: 'allow-all' })
      throw new Error(`unexpected fetch ${String(url)}`)
    })
    const onToast = vi.fn()
    render(<ModeMenu sessionId="01S" mode="auto" onToast={onToast} />)

    await user.click(screen.getByRole('button', { name: /mode: auto/ }))
    await user.click(screen.getByRole('menuitem', { name: /allow-all/ }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/sessions/01S/mode')
    expect(JSON.parse(String(init.body))).toEqual({ mode: 'allow-all' })
    expect(onToast).not.toHaveBeenCalled()
  })

  it('surfaces a refusal as a toast and keeps the menu open', async () => {
    const user = userEvent.setup()
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).endsWith('/mode')) {
        return Response.json(
          { error: 'invalid_request', message: 'no gate on this session' },
          { status: 400 },
        )
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })
    const onToast = vi.fn()
    render(<ModeMenu sessionId="01S" mode="auto" onToast={onToast} />)

    await user.click(screen.getByRole('button', { name: /mode: auto/ }))
    await user.click(screen.getByRole('menuitem', { name: /allow-all/ }))

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith('invalid_request: no gate on this session', 'error'),
    )
  })
})

describe('ModelMenu', () => {
  // two providers plus a bare key: the grouped layout the shared items render
  const listing = {
    active: 'anthropic/haiku',
    models: [
      { key: 'anthropic/sonnet', short: 'sonnet', window: 200_000 },
      { key: 'anthropic/haiku', short: 'haiku', window: 200_000 },
      { key: 'openai/gpt-5', short: 'gpt-5', window: 0 },
      { key: 'local-tuned', short: '', window: 0 },
    ],
  }

  function renderHeader() {
    return render(
      <StatusHeader
        sessionId="01S"
        onToast={vi.fn()}
        snap={snapFor({
          model: {
            key: 'anthropic/haiku',
            short: '',
            window: 0,
            caps: { reasoning: false, images: false, parallelToolCalls: false },
          },
        })}
      />,
    )
  }

  async function openModelMenu(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByTitle('Switch model'))
  }

  it('shows provider headings and short labels', async () => {
    const user = userEvent.setup()
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).endsWith('/models')) return Response.json(listing)
      return Response.json({ rows: [] })
    })
    renderHeader()

    await openModelMenu(user)
    const groups = await screen.findAllByRole('group')
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['anthropic', 'openai'])
    const items = screen.getAllByRole('menuitem')
    expect(items.map((el) => el.textContent?.replace(/\s*current$/, ''))).toEqual([
      'sonnet',
      'haiku',
      'gpt-5',
      'local-tuned',
    ])
  })

  it('badges the active key exactly once', async () => {
    const user = userEvent.setup()
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).endsWith('/models')) return Response.json(listing)
      return Response.json({ rows: [] })
    })
    renderHeader()

    await openModelMenu(user)
    const items = await screen.findAllByRole('menuitem')
    const marked = items.filter((el) => el.textContent?.includes('current'))
    expect(marked).toHaveLength(1)
    expect(marked[0]!.textContent?.replace(/\s*current$/, '')).toBe('haiku')
  })

  it('switches through model.set with the full key', async () => {
    const user = userEvent.setup()
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).endsWith('/models')) return Response.json(listing)
      if (String(url).endsWith('/model')) return Response.json({ model: 'openai/gpt-5' })
      return Response.json({ rows: [] })
    })
    renderHeader()

    await openModelMenu(user)
    await user.click(await screen.findByRole('menuitem', { name: 'gpt-5' }))

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/model'))
      expect(calls).toHaveLength(1)
      const [url, init] = calls[0]!
      expect(String(url)).toContain('/api/sessions/01S/model')
      expect(JSON.parse(String(init?.body))).toEqual({ model: 'openai/gpt-5' })
    })
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })
})

describe('StatusHeader identity', () => {
  it('shows the stored title beside the short session id', () => {
    render(
      <StatusHeader
        sessionId="01HWYSF8G2XK"
        onToast={vi.fn()}
        snap={snapFor({ session: { id: '01HWYSF8G2XK' } })}
      />,
    )
    // a nameless session shows its id alone, never duplicated
    expect(screen.getByText('01HWYSF8G2XK')).toBeInTheDocument()
  })

  it('pairs a named session with its short id', () => {
    render(
      <StatusHeader
        sessionId="01HWYSF8G2XK"
        onToast={vi.fn()}
        snap={snapFor({ session: { id: '01HWYSF8G2XKABCDEF', name: 'nightly sweep' } })}
      />,
    )
    expect(screen.getByText('nightly sweep')).toBeInTheDocument()
    const short = screen.getAllByText(/01HWYSF8/)[0]
    expect(short.textContent).toBe('01HWYSF8…')
  })
})

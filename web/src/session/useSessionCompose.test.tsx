import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSessionCompose } from './useSessionCompose'
import { resetDrafts } from './draftStore'
import { resetLedger } from '../workspace/attention'
import { SwarmProvider } from '../providers/swarm'
import { MockWebSocket } from '../test/mockWebSocket'

// The compose hook over the real stream client and fetch wrapper: draft
// persistence, recall-to-edit with its prefill notice, and the disabled state
// a holding dialog or unreachable session forces onto the composer.

const VIEW = '01COMPOSETEST0001'

class FetchRouter {
  handler = vi.fn((url: string | URL, _init?: RequestInit): Response => {
    const key = String(url)
      .replace(/^https?:\/\/[^/]+/, '')
      .split('?')[0]
    const respond = this.routes.get(key)
    if (!respond) throw new Error(`unexpected fetch ${String(url)}`)
    return respond()
  })

  private routes = new Map<string, () => Response>()

  on(url: string, respond: () => Response): this {
    this.routes.set(url, respond)
    return this
  }
}

function snapshotFor(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    session: { id: sessionId },
    workspace: '/home/you/project',
    cwd: '/home/you/project',
    head: '',
    model: {
      key: 'anthropic/claude-sonnet',
      short: 'sonnet',
      window: 200_000,
      caps: { reasoning: true, images: false, parallelToolCalls: true },
    },
    permission: 'auto',
    tools: [],
    usage: {
      turns: 0,
      total: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      child: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      estimatedTurns: 0,
    },
    context: { used: 1000, window: 200_000, reserve: 20_000, compact: 150_000, estimated: false },
    running: false,
    idle: true,
    spinning: false,
    queued: 0,
    queuedRows: [],
    activity: [],
    status: { segments: [] },
    seat: { held: false, yours: false },
    ...overrides,
  }
}

describe('useSessionCompose', () => {
  let fetcher: FetchRouter
  const sockets: MockWebSocket[] = []

  beforeEach(() => {
    localStorage.clear()
    resetDrafts() // drafts persist by session, so tests start from a clean slate
    resetLedger() // submits acknowledge turns into module state storage misses
    vi.stubGlobal(
      'WebSocket',
      class extends MockWebSocket {
        constructor(url: string) {
          super(url)
          sockets.push(this)
        }
      },
    )
    fetcher = new FetchRouter()
    // the provider's discovery polls ride along; only /recall answers matter
    fetcher
      .on('/api/sessions', () => Response.json([]))
      .on('/api/attention', () => Response.json([]))
    vi.stubGlobal('fetch', fetcher.handler)
  })

  afterEach(() => {
    sockets.length = 0
    vi.unstubAllGlobals()
  })

  function renderCompose(sessionId: string) {
    return renderHook(() => useSessionCompose(sessionId), {
      wrapper: ({ children }) => <SwarmProvider>{children}</SwarmProvider>,
    })
  }

  async function openSocket(): Promise<MockWebSocket> {
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0))
    const ws = sockets.at(-1)!
    act(() => ws.open())
    return ws
  }

  it('starts disabled while connecting and enables when live', async () => {
    const { result } = renderCompose(VIEW)
    expect(result.current.composerDisabled).toBe(true)
    expect(result.current.disabledReason).toBe('The session is not reachable right now.')
    expect(result.current.dialogs).toEqual([])

    const ws = await openSocket()
    act(() => {
      ws.message({ type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    })
    await waitFor(() => expect(result.current.composerDisabled).toBe(false))
  })

  it('disables the composer while a dialog holds input', async () => {
    const { result } = renderCompose(VIEW)
    const ws = await openSocket()
    act(() => {
      ws.message({
        type: 'init',
        sessionId: VIEW,
        state: snapshotFor(VIEW, {
          interactions: [
            { id: 42, kind: 'pick', prompt: 'Allow write access?', options: ['allow', 'deny'] },
          ],
        }),
        entries: [],
      })
    })

    await waitFor(() => expect(result.current.dialogs).toHaveLength(1))
    expect(result.current.composerDisabled).toBe(true)
    expect(result.current.disabledReason).toBe('A dialog needs an answer before prompts can send.')
  })

  it('recalls a queued prompt above an existing draft with a notice', async () => {
    fetcher.on(`/api/sessions/${VIEW}/recall`, () =>
      Response.json({ id: 'q1', text: 'recalled prompt' }),
    )
    const { result } = renderCompose(VIEW)
    const ws = await openSocket()
    act(() => {
      ws.message({ type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    })
    await waitFor(() => expect(result.current.composerDisabled).toBe(false))

    act(() => result.current.setDraft('my draft'))
    await act(async () => {
      await result.current.recallToEdit()
    })

    // the popped row merges above the draft, announced like every prefill
    expect(result.current.draft).toBe('recalled prompt\nmy draft')
    expect(result.current.toasts.some((t) => t.text === 'Placed above your existing draft.')).toBe(
      true,
    )
  })

  it('toasts the refusal when recall fails', async () => {
    fetcher.on(`/api/sessions/${VIEW}/recall`, () =>
      Response.json({ error: 'unavailable', message: 'a dialog holds input' }, { status: 409 }),
    )
    const { result } = renderCompose(VIEW)
    const ws = await openSocket()
    act(() => {
      ws.message({ type: 'init', sessionId: VIEW, state: snapshotFor(VIEW), entries: [] })
    })

    await act(async () => {
      await result.current.recallToEdit()
    })

    expect(result.current.toasts).toEqual([
      { id: 1, text: 'unavailable: a dialog holds input', level: 'error' },
    ])
    // nothing reached the composer
    expect(result.current.draft).toBe('')
  })
})

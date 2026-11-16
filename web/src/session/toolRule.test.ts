import { describe, expect, it, vi } from 'vitest'

import { applyToolSet, toolsWidenOnly } from './toolRule'
import type { CtlState, UsageState } from '../api/types'

// The one widen-only derivation and the one apply body every tool surface
// shares: locks appear only after the run dispatched a prompt, applies post
// the complete desired set, refusals toast.

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
}

function usageFor(turns: number): UsageState {
  return { turns, total: emptyUsage, child: emptyUsage, estimatedTurns: 0 }
}

function snapFor(overrides: Record<string, unknown> = {}): CtlState {
  return {
    session: { id: '01S' },
    workspace: '/w',
    cwd: '/w',
    head: '',
    model: {
      key: 'anthropic/claude-sonnet',
      short: 'sonnet',
      window: 200_000,
      caps: { reasoning: false, images: false, parallelToolCalls: false },
    },
    permission: '',
    tools: [],
    usage: usageFor(0),
    context: { used: 0, window: 200_000, reserve: 0, compact: 0, estimated: false },
    running: false,
    idle: true,
    spinning: false,
    queued: 0,
    seat: { held: false, yours: false },
    ...overrides,
  } as CtlState
}

describe('toolsWidenOnly', () => {
  it.each([
    ['fresh idle run', snapFor(), false],
    ['running turn', snapFor({ running: true, idle: false }), true],
    ['turns already dispatched', snapFor({ usage: usageFor(3) }), true],
  ])('locks %s', (_name, snap, locked) => {
    expect(toolsWidenOnly(snap as CtlState)).toBe(locked)
  })
})

describe('applyToolSet', () => {
  function stubFetch(respond: () => Response) {
    const spy = vi.fn(async (_url: string | URL, _init?: RequestInit) => respond())
    vi.stubGlobal('fetch', spy)
    return spy
  }

  const rows = [
    { name: 'read_file', enabled: true },
    { name: 'write_file', enabled: false },
  ]

  it('posts only the enabled names', async () => {
    const spy = stubFetch(() => Response.json({ rows: [] }))
    const onToast = vi.fn()

    await applyToolSet('01S', rows, onToast)

    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toContain('/api/sessions/01S/tools')
    expect(JSON.parse(String(init?.body))).toEqual({ names: ['read_file'] })
    expect(onToast).not.toHaveBeenCalled()
  })

  it('toasts a refusal and reports it', async () => {
    stubFetch(() =>
      Response.json({ error: 'unavailable', message: 'a turn owns the loop' }, { status: 409 }),
    )
    const onToast = vi.fn()

    const landed = await applyToolSet('01S', rows, onToast)

    expect(landed).toBe(false)
    expect(onToast).toHaveBeenCalledWith('a turn owns the loop', 'error')
  })

  it('reports true when the request lands', async () => {
    stubFetch(() => Response.json({ rows: [] }))
    const landed = await applyToolSet('01S', rows, vi.fn())
    expect(landed).toBe(true)
  })
})

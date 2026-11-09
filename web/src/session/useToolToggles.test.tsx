import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useToolToggles } from './useToolToggles'
import type { ToolState } from '../api/types'

// The intent machine every tools surface shares: flips land as intent keyed by
// the rows they were decided against, so successive flips compose into one
// posted set, the next tools event settles them, and refusals snap back.

function rowsFor(enabled: Record<string, boolean> = {}): ToolState[] {
  return [
    { name: 'read_file', source: 'built-in', enabled: enabled.read_file ?? false, readOnly: false },
    {
      name: 'write_file',
      source: 'built-in',
      enabled: enabled.write_file ?? false,
      readOnly: false,
    },
  ]
}

function stubFetch(respond: () => Response) {
  const spy = vi.fn(async (_url: string | URL, _init?: RequestInit) => respond())
  vi.stubGlobal('fetch', spy)
  return spy
}

function sentNames(spy: ReturnType<typeof stubFetch>): string[][] {
  return spy.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).names)
}

function mount(rows: ToolState[]) {
  const onToast = vi.fn()
  const view = renderHook(({ rows: current }) => useToolToggles('01S', current, onToast), {
    initialProps: { rows },
  })
  return { ...view, onToast }
}

describe('useToolToggles', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('composes successive toggles into one posted set', async () => {
    const spy = stubFetch(() => Response.json({ rows: [] }))
    const rows = rowsFor()
    const { result } = mount(rows)

    await act(async () => result.current.toggle(rows[0]))
    expect(result.current.enabledOf(rows[0])).toBe(true) // optimistic until settled
    expect(sentNames(spy)).toEqual([['read_file']])

    await act(async () => result.current.toggle(rows[1]))
    // the second post carries the first toggle's intent even though no tools
    // event landed in between
    expect(sentNames(spy)).toEqual([['read_file'], ['read_file', 'write_file']])
  })

  it('composes toggles fired within one tick', async () => {
    const spy = stubFetch(() => Response.json({ rows: [] }))
    const rows = rowsFor()
    const { result } = mount(rows)

    await act(async () => {
      result.current.toggle(rows[0])
      result.current.toggle(rows[1])
    })

    // deriving the second post from stale rows would silently undo the first
    expect(sentNames(spy)).toEqual([['read_file'], ['read_file', 'write_file']])
    expect(result.current.enabledOf(rows[0])).toBe(true)
    expect(result.current.enabledOf(rows[1])).toBe(true)
  })

  it('settles intent from the next tools event', async () => {
    stubFetch(() => Response.json({ rows: [] }))
    const initial = rowsFor()
    const { result, rerender } = mount(initial)

    await act(async () => result.current.toggle(initial[0]))
    expect(result.current.enabledOf(initial[0])).toBe(true)

    // the tools event confirms; the streamed fact decides now
    const confirmed = rowsFor({ read_file: true })
    rerender({ rows: confirmed })
    expect(result.current.enabledOf(confirmed[0])).toBe(true)

    // an external flip afterwards is never masked by stale intent
    const flipped = rowsFor()
    rerender({ rows: flipped })
    expect(result.current.enabledOf(flipped[0])).toBe(false)
  })

  it('posts from fresh rows once the stream settled earlier intent', async () => {
    const spy = stubFetch(() => Response.json({ rows: [] }))
    const initial = rowsFor()
    const { result, rerender } = mount(initial)

    await act(async () => result.current.toggle(initial[0]))
    const confirmed = rowsFor({ read_file: true })
    rerender({ rows: confirmed })

    await act(async () => result.current.toggle(confirmed[1]))
    // read_file rides the confirmed fact, not the settled intent
    expect(sentNames(spy)).toEqual([['read_file'], ['read_file', 'write_file']])
  })

  it('snaps a refused toggle back and toasts', async () => {
    const spy = stubFetch(() =>
      Response.json({ error: 'unavailable', message: 'a turn owns the loop' }, { status: 409 }),
    )
    const rows = rowsFor()
    const { result, onToast } = mount(rows)

    await act(async () => result.current.toggle(rows[0]))

    expect(spy).toHaveBeenCalledTimes(1)
    expect(onToast).toHaveBeenCalledWith('unavailable: a turn owns the loop', 'error')
    expect(result.current.enabledOf(rows[0])).toBe(false)
  })

  it('keeps settled rows through a late refusal', async () => {
    stubFetch(() =>
      Response.json({ error: 'unavailable', message: 'a turn owns the loop' }, { status: 409 }),
    )
    const initial = rowsFor()
    const { result, rerender } = mount(initial)

    act(() => result.current.toggle(initial[0])) // refusal still in flight
    const confirmed = rowsFor({ read_file: true })
    rerender({ rows: confirmed })

    await act(async () => {}) // the refusal lands after the tools event
    expect(result.current.enabledOf(confirmed[0])).toBe(true)
  })

  it('keeps a superseding toggle through the earlier refusal', async () => {
    stubFetch(() =>
      Response.json({ error: 'unavailable', message: 'a turn owns the loop' }, { status: 409 }),
    )
    const rows = rowsFor({ read_file: true, write_file: true })
    const { result } = mount(rows)

    await act(async () => {
      result.current.toggle(rows[0]) // wants read_file off
      result.current.toggle(rows[0]) // supersedes it: wants read_file back on
    })

    // the first refusal must not roll the second intent off
    expect(result.current.enabledOf(rows[0])).toBe(true)
  })
})

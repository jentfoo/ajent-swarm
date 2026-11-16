import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadProfile, saveSettleMs, useLayoutProfile } from './layoutProfile'
import type { TileSplit } from './tileTree'

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('layout profile', () => {
  it('round-trips through storage with each mode kept independently', () => {
    const { result } = renderHook(() => useLayoutProfile())
    act(() => result.current.setMode('tile'))
    act(() => {
      result.current.setTileLayout({
        tree: {
          kind: 'split',
          id: 'row1',
          dir: 'row',
          ratio: 0.6,
          a: { kind: 'pane', id: 'p1', tabs: ['s1'], active: 's1' },
          b: { kind: 'pane', id: 'p2', tabs: ['s2'], active: 's2' },
        },
        focusedPaneId: 'p2',
      })
    })

    // the burst settles into one write carrying the last change
    act(() => {
      vi.advanceTimersByTime(saveSettleMs)
    })
    const stored = JSON.parse(localStorage.getItem('swarm.workspace.v1')!)
    expect(stored.mode).toBe('tile')
    expect(stored.tile.focusedPaneId).toBe('p2')

    // a fresh mount restores the tile layout and selection independently
    const reloaded = loadProfile()
    expect(reloaded.mode).toBe('tile')
    expect((reloaded.tile.tree as TileSplit).ratio).toBe(0.6)
    expect(reloaded.tile.focusedPaneId).toBe('p2')
  })

  it('repairs corrupt storage instead of failing the load', () => {
    localStorage.setItem('swarm.workspace.v1', '{not json')
    expect(loadProfile().mode).toBe('focused')

    localStorage.setItem(
      'swarm.workspace.v1',
      JSON.stringify({ mode: 'tile', tile: { tree: { kind: 'bogus' } } }),
    )
    expect(loadProfile().tile.tree).toBeNull()
  })

  it('renders changes immediately while the save settles', () => {
    const { result } = renderHook(() => useLayoutProfile())
    act(() => result.current.setMode('tile'))

    // state moves now, storage waits out the settle window
    expect(result.current.profile.mode).toBe('tile')
    expect(localStorage.getItem('swarm.workspace.v1')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(saveSettleMs)
    })
    expect(JSON.parse(localStorage.getItem('swarm.workspace.v1')!).mode).toBe('tile')
  })

  it('settles a burst of changes into one storage write', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const { result } = renderHook(() => useLayoutProfile())
    act(() => {
      result.current.setMode('tile')
      result.current.setMode('focused')
      result.current.setMode('tile')
      result.current.selectFocusedSession('s1')
    })
    expect(setItem).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(saveSettleMs)
    })
    expect(setItem).toHaveBeenCalledTimes(1)
    const stored = JSON.parse(localStorage.getItem('swarm.workspace.v1')!)
    expect(stored.mode).toBe('tile')
    expect(stored.focused.selectedSessionId).toBe('s1')

    // a later burst schedules a fresh settle, one write per burst
    act(() => result.current.setMode('focused'))
    act(() => {
      vi.advanceTimersByTime(saveSettleMs)
    })
    expect(setItem).toHaveBeenCalledTimes(2)
  })

  it('restarts the settle window on every change', () => {
    const { result } = renderHook(() => useLayoutProfile())
    act(() => result.current.setMode('tile'))
    act(() => {
      vi.advanceTimersByTime(saveSettleMs - 50)
    })
    act(() => result.current.setTileLayout({ tree: null, focusedPaneId: 'p1' }))
    act(() => {
      vi.advanceTimersByTime(saveSettleMs - 50)
    })

    // still inside the restarted window: nothing landed yet
    expect(localStorage.getItem('swarm.workspace.v1')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(50)
    })
    const stored = JSON.parse(localStorage.getItem('swarm.workspace.v1')!)
    expect(stored.mode).toBe('tile')
    expect(stored.tile.focusedPaneId).toBe('p1')
  })

  it('flushes pending writes when the page unloads', () => {
    const { result } = renderHook(() => useLayoutProfile())
    act(() => result.current.setMode('tile'))
    expect(localStorage.getItem('swarm.workspace.v1')).toBeNull()

    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(JSON.parse(localStorage.getItem('swarm.workspace.v1')!).mode).toBe('tile')
  })

  it('flushes pending writes when the tab hides', () => {
    const { result } = renderHook(() => useLayoutProfile())
    act(() => result.current.setMode('tile'))

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    Reflect.deleteProperty(document, 'visibilityState')

    expect(JSON.parse(localStorage.getItem('swarm.workspace.v1')!).mode).toBe('tile')
  })

  it('flushes pending writes on unmount', () => {
    const hook = renderHook(() => useLayoutProfile())
    act(() => hook.result.current.setMode('tile'))

    hook.unmount()

    expect(JSON.parse(localStorage.getItem('swarm.workspace.v1')!).mode).toBe('tile')
  })
})

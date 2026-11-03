import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { loadProfile, useLayoutProfile } from './layoutProfile'
import type { TileSplit } from './tileTree'

beforeEach(() => {
  localStorage.clear()
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
})

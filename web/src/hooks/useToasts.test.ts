import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useToasts } from './useToasts'

describe('useToasts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('expires a toast after its display window', () => {
    const { result } = renderHook(() => useToasts())
    act(() => result.current.pushToast('gone soon'))
    expect(result.current.toasts).toHaveLength(1)

    act(() => vi.advanceTimersByTime(5_999))
    expect(result.current.toasts).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.toasts).toHaveLength(0)
  })

  it('expires each toast on its own window', () => {
    const { result } = renderHook(() => useToasts())
    act(() => result.current.pushToast('first'))
    act(() => vi.advanceTimersByTime(3_000))
    act(() => result.current.pushToast('second'))

    act(() => vi.advanceTimersByTime(3_001))
    expect(result.current.toasts.map((t) => t.text)).toEqual(['second'])

    act(() => vi.advanceTimersByTime(2_998))
    expect(result.current.toasts).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.toasts).toHaveLength(0)
  })

  it('keeps the newest toasts under the stack cap', () => {
    const { result } = renderHook(() => useToasts())
    act(() => {
      for (let i = 0; i < 8; i++) result.current.pushToast(`toast ${i}`)
    })
    expect(result.current.toasts.map((t) => t.text)).toEqual([
      'toast 4',
      'toast 5',
      'toast 6',
      'toast 7',
    ])
  })

  it('drops an evicted toast without touching survivors', () => {
    const { result } = renderHook(() => useToasts())
    act(() => {
      for (let i = 0; i < 4; i++) result.current.pushToast(`toast ${i}`)
    })
    act(() => vi.advanceTimersByTime(4_000))
    act(() => result.current.pushToast('toast 4'))
    expect(result.current.toasts.map((t) => t.text)).toEqual([
      'toast 1',
      'toast 2',
      'toast 3',
      'toast 4',
    ])

    // the evicted toast's expiry fires here as a no-op while its peers expire
    act(() => vi.advanceTimersByTime(2_001))
    expect(result.current.toasts.map((t) => t.text)).toEqual(['toast 4'])
  })

  it('clears pending expiries on unmount', () => {
    const { result, unmount } = renderHook(() => useToasts())
    act(() => result.current.pushToast('bye'))
    unmount()
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow()
  })
})

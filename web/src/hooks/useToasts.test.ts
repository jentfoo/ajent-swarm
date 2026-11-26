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

  it('pauses the expiry until resumed', () => {
    const { result } = renderHook(() => useToasts())
    act(() => result.current.pushToast('held'))
    act(() => vi.advanceTimersByTime(2_000))

    act(() => result.current.pauseToast(1))
    act(() => vi.advanceTimersByTime(30_000))
    expect(result.current.toasts).toHaveLength(1)

    // the window it still owes, not a fresh one
    act(() => result.current.resumeToast(1))
    act(() => vi.advanceTimersByTime(3_999))
    expect(result.current.toasts).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.toasts).toHaveLength(0)
  })

  it('keeps the first pause as the held window', () => {
    const { result } = renderHook(() => useToasts())
    act(() => result.current.pushToast('held'))
    act(() => vi.advanceTimersByTime(1_000))
    act(() => result.current.pauseToast(1))

    // a repeat pause finds no timer, so the held time never resets
    act(() => vi.advanceTimersByTime(10_000))
    act(() => result.current.pauseToast(1))
    act(() => result.current.resumeToast(1))
    act(() => vi.advanceTimersByTime(4_999))
    expect(result.current.toasts).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.toasts).toHaveLength(0)
  })

  it('dismiss clears the timer and drops the row', () => {
    const { result } = renderHook(() => useToasts())
    act(() => result.current.pushToast('gone'))
    act(() => result.current.dismissToast(1))
    expect(result.current.toasts).toEqual([])

    // the original expiry would have fired here without returning the row
    act(() => vi.advanceTimersByTime(60_000))
    expect(result.current.toasts).toEqual([])
  })

  it('dismisses one row without touching its peers', () => {
    const { result } = renderHook(() => useToasts())
    act(() => result.current.pushToast('gone'))
    act(() => result.current.pushToast('stays'))
    act(() => result.current.dismissToast(1))
    expect(result.current.toasts.map((t) => t.text)).toEqual(['stays'])

    act(() => vi.advanceTimersByTime(6_000))
    expect(result.current.toasts).toEqual([])
  })

  it('ignores a resume on a running toast', () => {
    const { result } = renderHook(() => useToasts())
    act(() => result.current.pushToast('running'))
    act(() => vi.advanceTimersByTime(1_000))

    // no fresh window: the original expiry stands
    act(() => result.current.resumeToast(1))
    act(() => vi.advanceTimersByTime(4_999))
    expect(result.current.toasts).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.toasts).toHaveLength(0)
  })

  it('ignores holds and dismissals for unknown ids', () => {
    const { result } = renderHook(() => useToasts())
    act(() => {
      result.current.pauseToast(7)
      result.current.resumeToast(7)
      result.current.dismissToast(7)
    })
    expect(result.current.toasts).toEqual([])
  })

  it('leaves nothing to hold once a toast expired', () => {
    const { result } = renderHook(() => useToasts())
    act(() => result.current.pushToast('gone'))
    act(() => vi.advanceTimersByTime(6_000))

    act(() => result.current.pauseToast(1))
    act(() => result.current.resumeToast(1))
    act(() => vi.advanceTimersByTime(6_000))
    expect(result.current.toasts).toEqual([])
  })
})

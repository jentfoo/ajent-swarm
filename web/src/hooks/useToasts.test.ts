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

  it('pushes a toast with the info level by default', () => {
    const { result } = renderHook(() => useToasts())
    act(() => result.current.pushToast('hello'))
    expect(result.current.toasts).toEqual([{ id: 1, text: 'hello', level: 'info' }])
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

  it('keeps the newest toasts under the stack cap', () => {
    const { result } = renderHook(() => useToasts())
    act(() => {
      for (let i = 0; i < 8; i++) result.current.pushToast(`toast ${i}`)
    })
    expect(result.current.toasts.map((t) => t.text)).toEqual([
      'toast 3',
      'toast 4',
      'toast 5',
      'toast 6',
      'toast 7',
    ])
  })

  it('clears pending expiries on unmount', () => {
    const { result, unmount } = renderHook(() => useToasts())
    act(() => result.current.pushToast('bye'))
    unmount()
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow()
  })
})

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useLongPress } from './useLongPress'
import type { PointerEvent as ReactPointerEvent } from 'react'

// The hold-to-rename gesture: fires only after the threshold, and any early
// release, pointer leaving or unmount cancels it.

function pointerEvent(isPrimary = true): ReactPointerEvent {
  return {
    isPrimary,
    // the hook reads nothing else off the event
  } as ReactPointerEvent
}

describe('useLongPress', () => {
  it('fires and unpresses once the hold passes the threshold', async () => {
    vi.useFakeTimers()
    try {
      const onLongPress = vi.fn()
      const { result } = renderHook(() => useLongPress(onLongPress))
      await act(async () => {
        result.current.onPointerDown(pointerEvent())
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(onLongPress).toHaveBeenCalledTimes(1)
      expect(result.current.pressed).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays pressed while the hold runs', async () => {
    vi.useFakeTimers()
    try {
      const onLongPress = vi.fn()
      const { result } = renderHook(() => useLongPress(onLongPress))
      act(() => {
        result.current.onPointerDown(pointerEvent())
      })
      await act(() => vi.advanceTimersByTimeAsync(499))
      expect(onLongPress).not.toHaveBeenCalled()
      expect(result.current.pressed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels on an early release', async () => {
    vi.useFakeTimers()
    try {
      const onLongPress = vi.fn()
      const { result } = renderHook(() => useLongPress(onLongPress))
      act(() => {
        result.current.onPointerDown(pointerEvent())
        result.current.onPointerUp()
      })
      await act(() => vi.advanceTimersByTimeAsync(1_000))
      expect(onLongPress).not.toHaveBeenCalled()
      expect(result.current.pressed).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores non-primary pointers', async () => {
    vi.useFakeTimers()
    try {
      const onLongPress = vi.fn()
      const { result } = renderHook(() => useLongPress(onLongPress))
      act(() => {
        result.current.onPointerDown(pointerEvent(false))
      })
      await act(() => vi.advanceTimersByTimeAsync(1_000))
      expect(onLongPress).not.toHaveBeenCalled()
      expect(result.current.pressed).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the pending hold on unmount', async () => {
    vi.useFakeTimers()
    try {
      const onLongPress = vi.fn()
      const { result, unmount } = renderHook(() => useLongPress(onLongPress))
      act(() => {
        result.current.onPointerDown(pointerEvent())
      })
      unmount()
      await act(() => vi.advanceTimersByTimeAsync(1_000))
      expect(onLongPress).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

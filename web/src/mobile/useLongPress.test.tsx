import { act, render, renderHook, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useLongPress } from './useLongPress'
import type { PointerEvent as ReactPointerEvent } from 'react'

// The hold-to-rename gesture: fires only after the threshold, and any early
// release, pointer leaving or unmount cancels it. A fired hold also suppresses
// the tap its release synthesizes wherever that click retargets, so these
// tests run against a small fixture wiring the row gesture inside an ancestor
// with its own click handler, the way SwitcherRows rides in a bottom sheet.

function pointerEvent(isPrimary = true): ReactPointerEvent {
  return {
    isPrimary,
    // the hook reads nothing else off the event
  } as ReactPointerEvent
}

function Harness({
  onLongPress,
  onTap,
  onBackdrop,
}: {
  onLongPress: () => void
  onTap: () => void
  onBackdrop: () => void
}) {
  const { onPointerDown, onPointerUp, onPointerLeave } = useLongPress(onLongPress)
  return (
    <div data-testid="backdrop" onClick={onBackdrop}>
      <div
        data-testid="row"
        onClick={onTap}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
      >
        row
      </div>
    </div>
  )
}

// holdFire presses the row past the rename threshold and releases it: pointerup
// for an in-place lift, or pointerout when a mouse drifts off mid-hold (React
// pairs out events into onPointerLeave). The caller decides where the browser's
// synthesized tap lands.
function holdFire(row: Element, release: 'pointerup' | 'pointerout' = 'pointerup') {
  act(() => {
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true }))
  })
  return act(async () => {
    await vi.advanceTimersByTimeAsync(500)
    if (release === 'pointerout') {
      row.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
      return
    }
    row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  })
}

function tap(target: Element) {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
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

  it('suppresses the tap that follows a fired hold', async () => {
    vi.useFakeTimers()
    try {
      const onLongPress = vi.fn()
      const onTap = vi.fn()
      const onBackdrop = vi.fn()
      render(<Harness onLongPress={onLongPress} onTap={onTap} onBackdrop={onBackdrop} />)

      await holdFire(screen.getByTestId('row'))
      expect(onLongPress).toHaveBeenCalledTimes(1)

      tap(screen.getByTestId('row'))
      expect(onTap).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('suppresses a release tap retargeted to an ancestor', async () => {
    vi.useFakeTimers()
    try {
      const onLongPress = vi.fn()
      const onTap = vi.fn()
      const onBackdrop = vi.fn()
      render(<Harness onLongPress={onLongPress} onTap={onTap} onBackdrop={onBackdrop} />)

      // the opened editor can leave the pointer over an overlay or ancestor
      await holdFire(screen.getByTestId('row'))
      tap(screen.getByTestId('backdrop'))
      expect(onTap).not.toHaveBeenCalled()
      expect(onBackdrop).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('suppresses the leak when a mouse release lands outside', async () => {
    vi.useFakeTimers()
    try {
      const onLongPress = vi.fn()
      const onTap = vi.fn()
      const onBackdrop = vi.fn()
      render(<Harness onLongPress={onLongPress} onTap={onTap} onBackdrop={onBackdrop} />)

      // mice have no pointer capture: the cursor drifts off mid-hold, so the
      // release lands outside and its click retargets to a common ancestor
      await holdFire(screen.getByTestId('row'), 'pointerout')
      tap(screen.getByTestId('backdrop'))
      expect(onLongPress).toHaveBeenCalledTimes(1)
      expect(onTap).not.toHaveBeenCalled()
      expect(onBackdrop).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes taps that do not follow a fired hold', async () => {
    vi.useFakeTimers()
    try {
      const onLongPress = vi.fn()
      const onTap = vi.fn()
      const onBackdrop = vi.fn()
      render(<Harness onLongPress={onLongPress} onTap={onTap} onBackdrop={onBackdrop} />)
      const row = screen.getByTestId('row')

      // an early release never fires, so the same tap passes through
      act(() => {
        row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true }))
        row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      })
      tap(row)
      expect(onTap).toHaveBeenCalledTimes(1)
      expect(onLongPress).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a fresh gesture tap through after suppression', async () => {
    vi.useFakeTimers()
    try {
      const onLongPress = vi.fn()
      const onTap = vi.fn()
      const onBackdrop = vi.fn()
      render(<Harness onLongPress={onLongPress} onTap={onTap} onBackdrop={onBackdrop} />)
      const row = screen.getByTestId('row')

      await holdFire(row)
      tap(row)
      expect(onTap).not.toHaveBeenCalled()

      // the next gesture starts with a pointerdown, which disarms the blocker:
      // its own early-release tap lands like any other
      act(() => {
        row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true }))
        row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      })
      tap(row)
      expect(onTap).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops suppressing once the block window expires', async () => {
    vi.useFakeTimers()
    try {
      const onLongPress = vi.fn()
      const onTap = vi.fn()
      const onBackdrop = vi.fn()
      render(<Harness onLongPress={onLongPress} onTap={onTap} onBackdrop={onBackdrop} />)
      const row = screen.getByTestId('row')

      await holdFire(row)
      // a tap arriving after the expiry is a deliberate one, not leakage
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      tap(row)
      expect(onTap).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

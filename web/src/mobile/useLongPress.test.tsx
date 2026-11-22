import { act, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLongPress } from './useLongPress'
import { pointAt } from '../test/elementFromPoint'
import type { PointerEvent as ReactPointerEvent } from 'react'

// The hold-to-open gesture: fires only after the threshold, and any early
// release, drag past the movement slop, pointer leaving or unmount cancels
// it. A fired hold also suppresses the tap its release synthesizes wherever
// that click retargets, so these tests run against a small fixture wiring
// the row gesture inside an ancestor with its own click handler, like a
// switcher row opening on tap. With a drag config the same machine extends
// past the hold: movement lifts the row into a drag whose target is the
// [data-session-id] row under the pointer, releasing over one drops.

function pointerEvent(isPrimary = true, x = 0, y = 0): ReactPointerEvent {
  return {
    isPrimary,
    clientX: x,
    clientY: y,
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
  const { onPointerDown, onPointerMove, onPointerUp, onPointerLeave } = useLongPress(onLongPress)
  return (
    <div data-testid="backdrop" onClick={onBackdrop}>
      <div
        data-testid="row"
        onClick={onTap}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
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

  it('fires at the press point', async () => {
    vi.useFakeTimers()
    try {
      const onLongPress = vi.fn()
      const { result } = renderHook(() => useLongPress(onLongPress))
      await act(async () => {
        result.current.onPointerDown(pointerEvent(true, 12, 34))
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(onLongPress).toHaveBeenCalledWith(12, 34)
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

  it('cancels past the movement slop', async () => {
    vi.useFakeTimers()
    try {
      const onLongPress = vi.fn()
      const { result } = renderHook(() => useLongPress(onLongPress))
      act(() => {
        result.current.onPointerDown(pointerEvent(true, 0, 0))
        // past the slop voids the hold; drifting back never re-arms it
        result.current.onPointerMove(pointerEvent(true, 20, 4))
        result.current.onPointerMove(pointerEvent(true, 2, -1))
      })
      await act(() => vi.advanceTimersByTimeAsync(1_000))
      expect(onLongPress).not.toHaveBeenCalled()
      expect(result.current.pressed).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds within the movement slop', async () => {
    vi.useFakeTimers()
    try {
      const onLongPress = vi.fn()
      const { result } = renderHook(() => useLongPress(onLongPress))
      await act(async () => {
        result.current.onPointerDown(pointerEvent(true, 0, 0))
        // a wobbly finger stays well inside the slop on either axis
        result.current.onPointerMove(pointerEvent(true, -6, 5))
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(onLongPress).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores non-primary movement', async () => {
    vi.useFakeTimers()
    try {
      const onLongPress = vi.fn()
      const { result } = renderHook(() => useLongPress(onLongPress))
      await act(async () => {
        result.current.onPointerDown(pointerEvent(true, 0, 0))
        // a second finger's travel is noise to this gesture
        result.current.onPointerMove(pointerEvent(false, 200, 200))
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(onLongPress).toHaveBeenCalledTimes(1)
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

  it('drag release taps pass through', async () => {
    vi.useFakeTimers()
    try {
      const onLongPress = vi.fn()
      const onTap = vi.fn()
      const onBackdrop = vi.fn()
      render(<Harness onLongPress={onLongPress} onTap={onTap} onBackdrop={onBackdrop} />)

      // press-drag past the slop cancels the hold: no rename fires, nothing
      // arms, and the release reads as an ordinary tap
      const row = screen.getByTestId('row')
      act(() => {
        row.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            isPrimary: true,
            clientX: 0,
            clientY: 0,
          }),
        )
        row.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            isPrimary: true,
            clientX: 40,
            clientY: -6,
          }),
        )
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
        row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      })
      expect(onLongPress).not.toHaveBeenCalled()

      tap(row)
      expect(onTap).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps post-fire movement blocking', async () => {
    vi.useFakeTimers()
    try {
      const onLongPress = vi.fn()
      const onTap = vi.fn()
      const onBackdrop = vi.fn()
      render(<Harness onLongPress={onLongPress} onTap={onTap} onBackdrop={onBackdrop} />)
      const row = screen.getByTestId('row')

      act(() => {
        row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true }))
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(onLongPress).toHaveBeenCalledTimes(1)

      // dragging after the hold fired changes nothing: its release still
      // suppresses the tap wherever that click lands
      act(() => {
        row.dispatchEvent(
          new PointerEvent('pointermove', { bubbles: true, isPrimary: true, clientX: 90 }),
        )
        row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      })
      tap(row)
      expect(onTap).not.toHaveBeenCalled()
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

// DragHarness wires the gesture with a drop config over two rows: the source
// carries the handlers, the neighbour stands in as the row a mocked
// elementFromPoint reports under the finger.
function DragHarness({
  onLongPress,
  onTapTarget,
  onDragStart,
  onDragTarget,
  onDrop,
  onDragEnd,
}: {
  onLongPress: () => void
  onTapTarget: () => void
  onDragStart: () => void
  onDragTarget: (sessionId: string | null) => void
  onDrop: (sessionId: string) => void
  onDragEnd: () => void
}) {
  const handlers = useLongPress(onLongPress, {
    canDrop: (id) => id === 'B',
    onDragStart,
    onDragTarget,
    onDrop,
    onDragEnd,
  })
  return (
    <div>
      <div data-testid="row" data-session-id="A" {...handlers}>
        source
      </div>
      <div data-testid="target" data-session-id="B" onClick={onTapTarget}>
        target
      </div>
    </div>
  )
}

describe('useLongPress drag', () => {
  const dragCallbacks = () => ({
    onDragStart: vi.fn(),
    onDragTarget: vi.fn(),
    onDrop: vi.fn(),
    onDragEnd: vi.fn(),
  })

  // elementFromPoint answers nothing until a test names the row beneath
  let under: ReturnType<typeof pointAt>
  beforeEach(() => {
    under = pointAt(null)
  })
  afterEach(() => {
    under.restore()
  })

  // holdLift presses past the threshold (the hold fires), then moves the
  // pointer onto the neighbour without releasing
  async function holdLift(row: Element) {
    act(() => {
      row.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          isPrimary: true,
          pointerId: 1,
          clientX: 0,
          clientY: 0,
        }),
      )
    })
    await act(() => vi.advanceTimersByTimeAsync(500))
    act(() => {
      row.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          isPrimary: true,
          pointerId: 1,
          clientX: 40,
          clientY: 0,
        }),
      )
    })
  }

  function release(row: Element) {
    act(() => {
      row.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          isPrimary: true,
          pointerId: 1,
          clientX: 40,
          clientY: 0,
        }),
      )
    })
  }

  it('lifts a moved hold into a drag and drops on the row under it', async () => {
    vi.useFakeTimers()
    try {
      const drag = dragCallbacks()
      const onLongPress = vi.fn()
      render(<DragHarness onLongPress={onLongPress} onTapTarget={() => {}} {...drag} />)
      const row = screen.getByTestId('row')
      const target = screen.getByTestId('target')
      under.set(target)

      await holdLift(row)
      // the hold fired first (its menu opens), then the movement converted
      // the same gesture into a drag reporting its target
      expect(onLongPress).toHaveBeenCalledTimes(1)
      expect(drag.onDragStart).toHaveBeenCalledTimes(1)
      expect(drag.onDragTarget).toHaveBeenCalledWith('B')

      release(row)
      expect(drag.onDrop).toHaveBeenCalledWith('B')
      expect(drag.onDragEnd).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends the drag without a drop over refused ground', async () => {
    vi.useFakeTimers()
    try {
      const drag = dragCallbacks()
      render(<DragHarness onLongPress={vi.fn()} onTapTarget={() => {}} {...drag} />)
      const row = screen.getByTestId('row')

      await holdLift(row)
      // no droppable row under the pointer: the target reads null
      expect(drag.onDragTarget).toHaveBeenCalledWith(null)

      release(row)
      expect(drag.onDrop).not.toHaveBeenCalled()
      expect(drag.onDragEnd).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never lifts without the hold firing', async () => {
    vi.useFakeTimers()
    try {
      const drag = dragCallbacks()
      render(<DragHarness onLongPress={vi.fn()} onTapTarget={() => {}} {...drag} />)
      const row = screen.getByTestId('row')

      // a plain press-drag past the slop scrolls: no hold fires, no drag
      // begins, and the release tap lands like any other
      act(() => {
        row.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            isPrimary: true,
            pointerId: 1,
            clientX: 0,
            clientY: 0,
          }),
        )
        row.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            isPrimary: true,
            pointerId: 1,
            clientX: 40,
            clientY: 0,
          }),
        )
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
        row.dispatchEvent(
          new PointerEvent('pointerup', { bubbles: true, isPrimary: true, pointerId: 1 }),
        )
      })
      expect(drag.onDragStart).not.toHaveBeenCalled()
      expect(drag.onDrop).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the drag when the platform steals the pointer', async () => {
    vi.useFakeTimers()
    try {
      const drag = dragCallbacks()
      render(<DragHarness onLongPress={vi.fn()} onTapTarget={() => {}} {...drag} />)
      const row = screen.getByTestId('row')

      await holdLift(row)
      act(() => {
        row.dispatchEvent(
          new PointerEvent('pointercancel', { bubbles: true, isPrimary: true, pointerId: 1 }),
        )
      })
      expect(drag.onDrop).not.toHaveBeenCalled()
      expect(drag.onDragEnd).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('suppresses the tap a drag release synthesizes', async () => {
    vi.useFakeTimers()
    try {
      const drag = dragCallbacks()
      const onTapTarget = vi.fn()
      render(<DragHarness onLongPress={vi.fn()} onTapTarget={onTapTarget} {...drag} />)
      const row = screen.getByTestId('row')
      const target = screen.getByTestId('target')

      // the release over the target row would otherwise open that row
      under.set(target)
      await holdLift(row)
      release(row)
      tap(target)
      expect(onTapTarget).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

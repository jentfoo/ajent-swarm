import { act, fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { usePullToRefresh } from './usePullToRefresh'

// The launcher's pull gesture against a real ancestor scroller: a release past
// the threshold at the very top fires once and shows a refreshing state, while
// short drags, scrolled pages, dead row wrappers and extra fingers stay silent.

// Harness mirrors the launcher's shape: the ref'd surface sits inside the page
// scroller, rows ride their own container. deadRows styles that container as a
// scroll wrapper whose content fits, the shape the unscoped sheet rule gave
// the launcher's rows.
function Harness({
  onRefresh,
  deadRows = false,
}: {
  onRefresh: () => Promise<void>
  deadRows?: boolean
}): ReactElement {
  const surface = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const refreshing = usePullToRefresh(surface, onRefresh)

  // jsdom lays nothing out, report real overflow so resolution lands on the
  // page scroller the way a long launcher page does
  useEffect(() => {
    const el = scroller.current!
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 800 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 200 })
  }, [])

  return (
    <div ref={scroller} data-testid="scroller" style={{ overflowY: 'auto' }}>
      <div ref={surface} data-testid="surface">
        <div data-testid="rows" style={deadRows ? { overflowY: 'auto' } : undefined}>
          <span data-testid="row">{refreshing ? 'refreshing' : 'idle'}</span>
        </div>
      </div>
    </div>
  )
}

// pullGesture rides one finger down (or up) and lifts it again
function pullGesture(el: HTMLElement, fromY: number, toY: number) {
  fireEvent.touchStart(el, { touches: [{ clientY: fromY }] })
  if (toY !== fromY) fireEvent.touchMove(el, { touches: [{ clientY: toY }] })
  fireEvent.touchEnd(el, { touches: [], changedTouches: [{ clientY: toY }] })
}

// settle flushes the refresh continuation's state updates inside act
function settle() {
  return act(async () => {})
}

describe('usePullToRefresh', () => {
  it('fires refresh past threshold', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const onRefresh = vi.fn(() => gate)

    render(<Harness onRefresh={onRefresh} />)

    // the touch lands on a deep row, so resolution and bubbling both play
    pullGesture(screen.getByTestId('row'), 200, 300)

    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('row')).toHaveTextContent('refreshing')

    act(() => release())
    await settle()
    expect(screen.getByTestId('row')).toHaveTextContent('idle')
  })

  it('ignores a short pull', async () => {
    const onRefresh = vi.fn(async () => {})

    render(<Harness onRefresh={onRefresh} />)
    pullGesture(screen.getByTestId('row'), 200, 240)

    expect(onRefresh).not.toHaveBeenCalled()
    expect(screen.getByTestId('row')).toHaveTextContent('idle')
  })

  it('ignores upward drags', async () => {
    const onRefresh = vi.fn(async () => {})

    render(<Harness onRefresh={onRefresh} />)
    pullGesture(screen.getByTestId('row'), 300, 200)

    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('keeps a scrolled page silent', async () => {
    const onRefresh = vi.fn(async () => {})

    render(<Harness onRefresh={onRefresh} />)
    screen.getByTestId('scroller').scrollTop = 400
    pullGesture(screen.getByTestId('row'), 200, 320)
    expect(onRefresh).not.toHaveBeenCalled()

    // back at the top, the same drag plays
    screen.getByTestId('scroller').scrollTop = 0
    pullGesture(screen.getByTestId('row'), 200, 300)
    await settle()
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('ignores scroll away and return', async () => {
    const onRefresh = vi.fn(async () => {})

    render(<Harness onRefresh={onRefresh} />)
    const scroller = screen.getByTestId('scroller')
    const row = screen.getByTestId('row')

    // the drag scrolls the page away from the top, then continues down past
    // its own start once back at rest: never a pull from the top
    fireEvent.touchStart(row, { touches: [{ clientY: 200 }] })
    scroller.scrollTop = 400
    fireEvent.touchMove(row, { touches: [{ clientY: 120 }] })
    scroller.scrollTop = 0
    fireEvent.touchMove(row, { touches: [{ clientY: 320 }] })
    fireEvent.touchEnd(row, { touches: [], changedTouches: [{ clientY: 320 }] })
    expect(onRefresh).not.toHaveBeenCalled()

    // the voided touch leaves nothing behind, a pull from rest still plays
    pullGesture(row, 200, 300)
    await settle()
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('ignores returning from mid-page', async () => {
    const onRefresh = vi.fn(async () => {})

    render(<Harness onRefresh={onRefresh} />)
    const scroller = screen.getByTestId('scroller')

    // a downward drag that starts scrolled only reaches the top partway
    // through, so its tail sits past the start point at rest
    scroller.scrollTop = 400
    const row = screen.getByTestId('row')
    fireEvent.touchStart(row, { touches: [{ clientY: 200 }] })
    fireEvent.touchMove(row, { touches: [{ clientY: 240 }] })
    scroller.scrollTop = 0
    fireEvent.touchMove(row, { touches: [{ clientY: 340 }] })
    fireEvent.touchEnd(row, { touches: [], changedTouches: [{ clientY: 340 }] })

    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('skips a dead inner scroller', async () => {
    const onRefresh = vi.fn(async () => {})

    // the launcher bug's shape: a row whose nearest styled scroller never
    // scrolls while the page holds content above, so a mid-list drag down
    // must read the page and stay silent
    render(<Harness onRefresh={onRefresh} deadRows />)
    screen.getByTestId('scroller').scrollTop = 400
    pullGesture(screen.getByTestId('row'), 200, 320)
    expect(onRefresh).not.toHaveBeenCalled()

    // at the top the dead wrapper never blocks the gesture either
    screen.getByTestId('scroller').scrollTop = 0
    pullGesture(screen.getByTestId('row'), 200, 300)
    await settle()
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('drops overlap during refresh', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const onRefresh = vi.fn(() => gate)

    render(<Harness onRefresh={onRefresh} />)
    pullGesture(screen.getByTestId('row'), 200, 300)
    expect(onRefresh).toHaveBeenCalledTimes(1)

    // a second pull while the first refresh is in flight never stacks
    pullGesture(screen.getByTestId('row'), 200, 320)
    expect(onRefresh).toHaveBeenCalledTimes(1)

    act(() => release())
    await settle()
    expect(screen.getByTestId('row')).toHaveTextContent('idle')
    pullGesture(screen.getByTestId('row'), 200, 300)
    await settle()
    expect(onRefresh).toHaveBeenCalledTimes(2)
  })

  it('keeps a pinch from pulling', async () => {
    const onRefresh = vi.fn(async () => {})

    render(<Harness onRefresh={onRefresh} />)

    // one finger seeds the gesture, a second landing mid-drag kills it even
    // when the last finger lifts far below where the first landed
    const row = screen.getByTestId('row')
    fireEvent.touchStart(row, { touches: [{ clientY: 200 }] })
    fireEvent.touchStart(row, {
      touches: [{ clientY: 200 }, { clientY: 260 }],
    })
    fireEvent.touchMove(row, {
      touches: [{ clientY: 200 }, { clientY: 400 }],
    })
    fireEvent.touchEnd(row, { touches: [{ clientY: 200 }], changedTouches: [{ clientY: 400 }] })

    expect(onRefresh).not.toHaveBeenCalled()
  })
})

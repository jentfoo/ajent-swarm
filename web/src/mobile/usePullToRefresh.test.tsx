import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { usePullToRefresh } from './usePullToRefresh'

// The launcher's pull gesture against a real ancestor scroller: a release past
// the threshold at the very top fires once and shows a refreshing state, while
// short drags, scrolled pages and extra fingers stay silent.

function Harness({ onRefresh }: { onRefresh: () => Promise<void> }): ReactElement {
  const surface = useRef<HTMLDivElement>(null)
  const refreshing = usePullToRefresh(surface, onRefresh)
  return (
    <div data-testid="scroller" style={{ height: 200, overflowY: 'auto' }}>
      {/* the ref'd surface sits inside the scroller, like a screen root does */}
      <div ref={surface} data-testid="surface">
        <span data-testid="row">{refreshing ? 'refreshing' : 'idle'}</span>
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

    // one finger seeds the gesture; a second landing mid-drag kills it even
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

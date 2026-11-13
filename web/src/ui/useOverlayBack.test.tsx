import { StrictMode } from 'react'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useOverlayBack } from './useOverlayBack'

// The overlay↔history loop against the real window history: opening stamps an
// entry, a pop event closes the topmost layer, and a layer's own close steps
// back over its entry, never over one another's, never twice, never once the
// router has pushed past it, and never on an entry left unmarked. Stacked
// teardowns unwind every dead entry they leave behind, and a consume
// superseded mid-flight dies with the next landing. Every test leaves history
// settled, so no pending traversal bleeds into the next one.

function Layer({ onClose }: { onClose: () => void }): ReactElement {
  useOverlayBack(onClose)
  return <p>layer</p>
}

function Harness({
  a = false,
  b = false,
  onCloseA = () => {},
  onCloseB = () => {},
}: {
  a?: boolean
  b?: boolean
  onCloseA?: () => void
  onCloseB?: () => void
}): ReactElement {
  return (
    <>
      {a && <Layer onClose={onCloseA} />}
      {b && <Layer onClose={onCloseB} />}
    </>
  )
}

// Gate mounts the layer behind an open flag, for rendering directly under a
// root StrictMode, the placement that double-invokes effects like the app's
// dev render does
function Gate({ open }: { open: boolean }): ReactElement | null {
  return open ? <Layer onClose={() => {}} /> : null
}

// stamp reads this module's mark off the current history entry, the same way
// the implementation does
function stamp(): number | undefined {
  const state: unknown = window.history.state
  if (typeof state !== 'object' || state === null) return undefined
  const value = (state as Record<string, unknown>).swarmOverlay
  return typeof value === 'number' ? value : undefined
}

// settle delivers the popstate a mocked history.back would have fired. The
// mocked traversal leaves history in place, so a settle can read as a foreign
// back that closes the top layer, a no-op once no layers remain
function settle(): void {
  window.dispatchEvent(new PopStateEvent('popstate'))
}

// each test stands on one unmarked base entry, so a stamp or its absence
// always names this test's own entries and never a leftover from the last
beforeEach(() => {
  window.history.replaceState(null, '', window.location.href)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useOverlayBack', () => {
  it('pushes a stamped entry while open and consumes it on close', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { rerender } = render(<Harness a />)

    expect(stamp()).toBeTypeOf('number')

    rerender(<Harness />)
    expect(back).toHaveBeenCalledTimes(1) // our own entry, not the router's
    settle()
  })

  it('closes only the topmost layer on a pop event', () => {
    const closeA = vi.fn()
    const closeB = vi.fn()
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { rerender } = render(<Harness a b onCloseA={closeA} onCloseB={closeB} />)

    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(closeB).toHaveBeenCalledTimes(1)
    expect(closeA).not.toHaveBeenCalled()

    // the state change the close drives unmounts the layer and consumes it
    // each settle delivers the pop the mocked traversal skipped
    rerender(<Harness a onCloseA={closeA} />)
    expect(back).toHaveBeenCalledTimes(1)
    settle()
    rerender(<Harness onCloseA={closeA} />)
    settle()
  })

  it('never consumes an entry another live layer owns', async () => {
    const closeA = vi.fn()
    const closeB = vi.fn()
    const back = vi.spyOn(window.history, 'back')
    const view = render(<Harness a onCloseA={closeA} />)
    const stampA = stamp()
    view.rerender(<Harness a b onCloseA={closeA} onCloseB={closeB} />)

    // hardware back pops the top layer's entry and lands on the one below
    window.history.back()
    await vi.waitFor(() => expect(closeB).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(stamp()).toBe(stampA))
    expect(closeA).not.toHaveBeenCalled()

    // closing the popped layer must not step back over its neighbor's entry
    view.rerender(<Harness a onCloseA={closeA} />)
    expect(back).toHaveBeenCalledTimes(1) // only the test's own traversal

    // the neighbor still consumes its own entry when its turn comes, landing
    // on the adopted base entry below it
    view.rerender(<Harness onCloseA={closeA} />)
    await vi.waitFor(() => expect(stamp()).not.toBe(stampA))
    expect(back).toHaveBeenCalledTimes(2)
  })

  it('a teardown only pops entries their own layers still own', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { rerender } = render(<Harness a b />)
    expect(stamp()).toBeTypeOf('number')

    // one rerender tears both layers down, the timeout-driven case: the lower
    // layer's cleanup runs first and declines (the top entry is its
    // neighbor's), so exactly one pop follows for one owned entry, never a
    // double pop
    rerender(<Harness />)
    expect(back).toHaveBeenCalledTimes(1)
    settle()
  })

  it('unwinds every dead entry a stacked teardown leaves', async () => {
    const back = vi.spyOn(window.history, 'back')
    const view = render(<Harness a />)
    const stampA = stamp()
    view.rerender(<Harness a b />)
    const stampB = stamp()

    // both layers tear down at once: the first consume lands on the neighbor's
    // dead entry and the chain consumes it too, so history ends on the base
    // entry the stack started on instead of one no-op press above it
    view.rerender(<Harness />)
    await vi.waitFor(() => expect(stamp()).not.toBe(stampB))
    await vi.waitFor(() => expect(stamp()).not.toBe(stampA))
    expect(back).toHaveBeenCalledTimes(2)
  })

  it('a cancelled traversal cannot swallow a later genuine back', async () => {
    const closeA = vi.fn()
    const closeB = vi.fn()
    const back = vi.spyOn(window.history, 'back')
    const view = render(<Harness a b onCloseA={closeA} onCloseB={closeB} />)

    // the close queues a consume traversal, a reopen pushes before it runs,
    // and that push cancels the traversal in jsdom and in browsers
    view.rerender(<Harness a onCloseA={closeA} onCloseB={closeB} />)
    view.rerender(<Harness a b onCloseA={closeA} onCloseB={closeB} />)

    // each genuine back must close the reopened layer, a stale land stamp from
    // the cancelled traversal would swallow the second press
    window.history.back()
    await vi.waitFor(() => expect(closeB).toHaveBeenCalledTimes(1))
    window.history.back()
    await vi.waitFor(() => expect(closeB).toHaveBeenCalledTimes(2))
    expect(closeA).not.toHaveBeenCalled()

    // unmounting what is left consumes the one dead entry still current: the
    // cancelled traversal, both genuine backs and this consume make four
    view.rerender(<Harness onCloseA={closeA} onCloseB={closeB} />)
    await vi.waitFor(() => expect(back).toHaveBeenCalledTimes(4))
  })

  it('a superseded consume never blocks a later teardown', async () => {
    const closeA = vi.fn()
    const back = vi.spyOn(window.history, 'back')
    const view = render(<Harness a b onCloseA={closeA} />)
    const stampA = stamp()
    const stampB = stamp()

    // the close queues a consume, a router push above it cancels the traversal
    // before it lands, stranding the expectation
    view.rerender(<Harness a onCloseA={closeA} />)
    window.history.pushState({ usr: null, key: 'k', idx: 5 }, '/other')

    // the genuine back over the router entry lands on the closed layer's dead
    // entry and still closes the top layer, the teardown that follows must not
    // be blocked by the stranded expectation
    window.history.back()
    await vi.waitFor(() => expect(closeA).toHaveBeenCalledTimes(1))
    view.rerender(<Harness onCloseA={closeA} />)
    await vi.waitFor(() => expect(back).toHaveBeenCalledTimes(4))
    expect(stamp()).not.toBe(stampB)
    expect(stamp()).not.toBe(stampA)
  })

  it('leaves history alone once the router pushed past the entry', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { rerender } = render(<Harness a />)

    // a router navigation above the overlay, the switcher's session switch
    window.history.pushState({ usr: null, key: 'k', idx: 4 }, '/s/other')
    rerender(<Harness />)
    expect(back).not.toHaveBeenCalled()
  })

  it('still consumes its entry after a StrictMode remount', async () => {
    const back = vi.spyOn(window.history, 'back')
    const { rerender } = render(
      <StrictMode>
        <Gate open />
      </StrictMode>,
    )

    expect(stamp()).toBeTypeOf('number')
    rerender(
      <StrictMode>
        <Gate open={false} />
      </StrictMode>,
    )
    // the dev-only double mount bounces one entry of its own (its queued
    // traversal dies when the remount pushes), then the real close consumes
    // the remount's entry and the chain unwinds the leftover beneath it
    await vi.waitFor(() => expect(back).toHaveBeenCalledTimes(3))
    // jsdom cancels the first queued traversal when the remount pushes its
    // entry, so the popstates it would have fired are settled by hand
    settle()
    settle()
  })
})

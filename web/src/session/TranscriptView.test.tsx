import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { applierReducer, initialSessionState } from '../state/eventApplier'
import type { AppliedSessionState } from '../state/eventApplier'
import { initFrame, messageEntry, testState } from '../state/testFixtures'
import type { LoadOlderResult } from '../stream/sessionStore'
import { TranscriptView } from './TranscriptView'

// The transcript's pull-to-latest listener: a single finger crossing the
// threshold at rest at the top jumps to the latest row, while a touch that
// scrolled first — even one back at rest past its start — and any pinch stay
// dead, mirroring usePullToRefresh.

function renderTranscript(): HTMLElement {
  render(
    <TranscriptView
      sessionId="01TESTSESSION0000"
      state={initialSessionState()}
      loadOlder={async () => ({ kind: 'dry' })}
      pullDownToLatest
      onThinkingToggle={() => {}}
    />,
  )

  // jsdom lays nothing out; a long transcript stands in so the pill's
  // not-at-bottom check and the jump's scrollTop write behave like the real
  // scroller, which rests at scrollTop 0 here — where pulls may play
  const el = document.querySelector('.transcript-scroll') as HTMLElement
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 2000 })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 300 })
  return el
}

// showPill disengages autoscroll with one upward scroll away from the bottom,
// so the ↓ latest button marks both where a jump may fire and that one did.
// It leaves the scroller at rest at the top, where the pull gesture lives.
function showPill(el: HTMLElement) {
  act(() => {
    el.scrollTop = 500
    el.dispatchEvent(new Event('scroll'))
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  })
}

describe('TranscriptView pull to latest', () => {
  it('jumps to latest past the threshold', () => {
    const el = renderTranscript()
    showPill(el)
    expect(screen.getByText('↓ latest')).toBeInTheDocument()

    fireEvent.touchStart(el, { touches: [{ clientY: 300 }] })
    fireEvent.touchMove(el, { touches: [{ clientY: 380 }] })

    expect(screen.queryByText('↓ latest')).not.toBeInTheDocument()
  })

  it('ignores scroll away and return', () => {
    const el = renderTranscript()
    showPill(el)

    // the drag scrolls the page away from the top, then continues down past
    // its own start once back at rest: never a pull from the top
    fireEvent.touchStart(el, { touches: [{ clientY: 300 }] })
    el.scrollTop = 400
    fireEvent.touchMove(el, { touches: [{ clientY: 200 }] })
    el.scrollTop = 0
    fireEvent.touchMove(el, { touches: [{ clientY: 400 }] })

    expect(screen.getByText('↓ latest')).toBeInTheDocument()

    // the voided touch leaves nothing behind; a pull from rest still jumps
    fireEvent.touchEnd(el, { touches: [], changedTouches: [{ clientY: 400 }] })
    fireEvent.touchStart(el, { touches: [{ clientY: 300 }] })
    fireEvent.touchMove(el, { touches: [{ clientY: 380 }] })

    expect(screen.queryByText('↓ latest')).not.toBeInTheDocument()
  })

  it('keeps a pinch from jumping', () => {
    const el = renderTranscript()
    showPill(el)

    // one finger seeds the gesture; a second landing mid-drag kills it even
    // when the remaining finger keeps dragging far past the start
    fireEvent.touchStart(el, { touches: [{ clientY: 300 }] })
    fireEvent.touchStart(el, { touches: [{ clientY: 300 }, { clientY: 340 }] })
    fireEvent.touchMove(el, { touches: [{ clientY: 380 }, { clientY: 500 }] })

    expect(screen.getByText('↓ latest')).toBeInTheDocument()
  })
})

// The load-older control: a failed page paints its reason under the button and
// leaves the control live for another attempt, while a dry page stays quiet.
function unrootedState(): AppliedSessionState {
  return applierReducer(initialSessionState(), {
    type: 'init',
    frame: initFrame(testState({ head: 'e2' }), [messageEntry('e2', 'e1', 'assistant', 'newest')]),
  })
}

describe('TranscriptView load older failures', () => {
  const loadOlderButton = () => screen.getByRole('button', { name: 'Load older history' })

  function renderLoadOlder(loadOlder: () => Promise<LoadOlderResult>) {
    render(
      <TranscriptView
        sessionId="01TESTSESSION0000"
        state={unrootedState()}
        loadOlder={loadOlder}
        onThinkingToggle={() => {}}
      />,
    )
  }

  it('shows failure reason inline', async () => {
    renderLoadOlder(async () => ({ kind: 'failed', message: 'network_error: request failed' }))
    fireEvent.click(loadOlderButton())

    expect(await screen.findByText('network_error: request failed')).toBeInTheDocument()
    // the control stays live so clicking again retries
    expect(loadOlderButton()).toBeEnabled()
  })

  it('clears reason on retry', async () => {
    let fail = true
    renderLoadOlder(async () =>
      fail ? { kind: 'failed', message: 'network down' } : { kind: 'loaded' },
    )
    fireEvent.click(loadOlderButton())
    expect(await screen.findByText('network down')).toBeInTheDocument()

    fail = false // the retried page lands and the stale reason retires
    fireEvent.click(loadOlderButton())
    await waitFor(() => expect(screen.queryByText('network down')).not.toBeInTheDocument())
  })

  it('retires a stale reason when dry answers', async () => {
    let fail = true
    renderLoadOlder(async () =>
      fail ? { kind: 'failed', message: 'network down' } : { kind: 'dry' },
    )
    fireEvent.click(loadOlderButton())
    expect(await screen.findByText('network down')).toBeInTheDocument()

    fail = false // the server answering dry is a definitive answer too
    fireEvent.click(loadOlderButton())
    await waitFor(() => expect(screen.queryByText('network down')).not.toBeInTheDocument())
  })

  it('stays quiet on dry', async () => {
    renderLoadOlder(async () => ({ kind: 'dry' }))
    fireEvent.click(loadOlderButton())

    // the dry answer churns nothing; flush the resolved read before judging
    await act(async () => {})
    expect(document.querySelector('.transcript-wrap .error-text')).toBeNull()
    expect(loadOlderButton()).toBeInTheDocument()
  })
})

// The phone keyboard shrinks the scroller step by step while the inset lifts
// the composer, and WebKit's focus reveal pass can leave the stuck tail
// anywhere along the way: each resize re-pins a stuck view and leaves a
// reader scrolled away from the tail alone.
describe('TranscriptView keyboard shrink', () => {
  it('repins_stuck_view_on_scroller_resize', () => {
    // jsdom ships no observer, so every ResizeObserver under this render is
    // recorded and fired together, like one real resize batch
    const fireAll: (() => void)[] = []
    class RecordingRO {
      constructor(cb: ResizeObserverCallback) {
        fireAll.push(() => cb([] as unknown as ResizeObserverEntry[], null as never))
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const real = globalThis.ResizeObserver
    globalThis.ResizeObserver = RecordingRO as unknown as typeof ResizeObserver
    try {
      const el = renderTranscript()

      // WebKit's reveal pass left the tail stranded mid-scroll; the next
      // inset step's resize re-pins it
      el.scrollTop = 500
      act(() => fireAll.forEach((fire) => fire()))
      expect(el.scrollTop).toBe(2000)

      // a reader scrolled away from the tail keeps their place
      showPill(el)
      el.scrollTop = 400
      act(() => fireAll.forEach((fire) => fire()))
      expect(el.scrollTop).toBe(400)
    } finally {
      globalThis.ResizeObserver = real
    }
  })
})

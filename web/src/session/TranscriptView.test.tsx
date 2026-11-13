import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applierReducer, initialSessionState } from '../state/eventApplier'
import type { AppliedSessionState } from '../state/eventApplier'
import * as derive from '../state/derive'
import { entry, ev, initFrame, messageEntry, testState } from '../state/testFixtures'
import type { WireEvent } from '../api/types'
import type { LoadOlderResult } from '../stream/sessionStore'
import { TranscriptView } from './TranscriptView'

// The transcript's pull-to-latest listener: a single finger crossing the
// threshold at rest at the top jumps to the latest row, while a touch that
// scrolled first (even one back at rest past its start) and any pinch stay
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

  // jsdom lays nothing out, a long transcript stands in so the pill's
  // not-at-bottom check and the jump's scrollTop write behave like the real
  // scroller, which rests at scrollTop 0 here, where pulls may play
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

    // the voided touch leaves nothing behind, a pull from rest still jumps
    fireEvent.touchEnd(el, { touches: [], changedTouches: [{ clientY: 400 }] })
    fireEvent.touchStart(el, { touches: [{ clientY: 300 }] })
    fireEvent.touchMove(el, { touches: [{ clientY: 380 }] })

    expect(screen.queryByText('↓ latest')).not.toBeInTheDocument()
  })

  it('keeps a pinch from jumping', () => {
    const el = renderTranscript()
    showPill(el)

    // one finger seeds the gesture, a second landing mid-drag kills it even
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

    // the dry answer churns nothing, flush the resolved read before judging
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

      // WebKit's reveal pass left the tail stranded mid-scroll, the next
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

// The streaming-burst fence: the applier swaps live.tools on every tool event,
// but committed blocks may re-derive only when the hidden call membership or a
// readable verdict moves. A burst of output chunks through one chatty call must
// leave settled history derived exactly as it was. rAF runs synchronously so
// each rerender commits its throttled live value at once.
describe('TranscriptView streaming burst', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // Committed history: a user prompt, its assistant turn opening one Bash
  // call. The live card for that same call id hides the committed twin until a
  // carrier folds the result and retires the buffer.
  function burstState(): AppliedSessionState {
    const e1 = messageEntry('e1', undefined, 'user', 'run the tests')
    const e2 = entry('e2', 'e1', 'message', {
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_call', data: { id: 'call_1', name: 'Bash', input: { cmd: 'go test' } } },
        ],
      },
    })
    return applierReducer(initialSessionState(), {
      type: 'init',
      frame: initFrame(testState({ head: 'e2' }), [e1, e2]),
    })
  }

  function mountBurst(state: AppliedSessionState) {
    const spy = vi.spyOn(derive, 'deriveBlocks')
    let current = state
    const view = render(
      <TranscriptView
        sessionId="01TESTSESSION0000"
        state={current}
        loadOlder={async () => ({ kind: 'dry' })}
        onThinkingToggle={() => {}}
      />,
    )
    const apply = (...events: WireEvent[]) => {
      for (const event of events) {
        current = applierReducer(current, { type: 'event', event })
        view.rerender(
          <TranscriptView
            sessionId="01TESTSESSION0000"
            state={current}
            loadOlder={async () => ({ kind: 'dry' })}
            onThinkingToggle={() => {}}
          />,
        )
      }
    }
    return { apply, count: () => spy.mock.calls.length }
  }

  const cards = () => document.querySelectorAll('[data-tool-id="call_1"]')

  it('derives once across output burst', () => {
    const { apply, count } = mountBurst(burstState())
    expect(count()).toBe(1)
    expect(cards()).toHaveLength(1) // the committed twin paints before any live card

    apply(ev('turn.start', 1, { model: 'sonnet' }))
    expect(count()).toBe(1) // an empty buffer hides nothing new

    apply(ev('tool.start', 2, { id: 'call_1', name: 'Bash', input: { cmd: 'go test' } }))
    expect(count()).toBe(2) // the live card now hides its committed twin
    expect(cards()).toHaveLength(1)

    const burst = 50
    for (let i = 0; i < burst; i++) {
      apply(ev('tool.output', 3 + i, { id: 'call_1', delta: `line ${i}\n` }))
    }
    apply(ev('tool.progress', 3 + burst, { id: 'call_1', bytes: 4096, lines: burst }))
    apply(ev('notice', 4 + burst, { text: 'Tool auto allowed' }))
    apply(ev('tool.result', 5 + burst, { id: 'call_1', name: 'Bash', output: 'ok' }))
    expect(count()).toBe(2) // the whole burst moved no membership
  })

  it('rederives when card retires', () => {
    const { apply, count } = mountBurst(burstState())
    apply(
      ev('turn.start', 1, { model: 'sonnet' }),
      ev('tool.start', 2, { id: 'call_1', name: 'Bash', input: { cmd: 'go test' } }),
      ev('notice', 3, { text: 'Tool auto allowed' }),
      ev('tool.output', 4, { id: 'call_1', delta: 'streaming\n' }),
    )
    const before = count()

    const carrier = entry('e3', 'e2', 'message', {
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            data: { callId: 'call_1', content: [{ type: 'text', data: { text: 'ok' } }] },
          },
        ],
      },
    })
    apply(ev('entry.append', 5, { entry: carrier }))

    // the buffer drained, one derivation swaps the hidden twin back in with
    // its folded result and the permit chip the verdict ledger held
    expect(count()).toBe(before + 1)
    expect(cards()).toHaveLength(1)
    expect(screen.getByText('auto allowed')).toBeInTheDocument()
    expect(screen.getByText('done')).toBeInTheDocument()
    expect(screen.queryByText('live')).not.toBeInTheDocument()
  })
})

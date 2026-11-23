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

// showPill disengages autoscroll with one user-driven upward scroll away from
// the bottom, so the ↓ latest button marks both where a jump may fire and that
// one did. It leaves the scroller at rest at the top, where the pull gesture
// lives.
function showPill(el: HTMLElement) {
  act(() => {
    fireEvent.wheel(el, { deltaY: -120 }) // the user's upward scroll input
    el.scrollTop = 500
    el.dispatchEvent(new Event('scroll'))
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  })
}

// mountTranscript hosts one view over a mutable state slot, so tests apply
// reducer actions between renders the way the live channel does.
function mountTranscript(initial: AppliedSessionState, sessionId = '01TESTSESSION0000') {
  let current = initial
  let id = sessionId
  const draw = () => (
    <TranscriptView
      sessionId={id}
      state={current}
      loadOlder={async () => ({ kind: 'dry' })}
      onThinkingToggle={() => {}}
    />
  )
  const view = render(draw())
  const el = document.querySelector('.transcript-scroll') as HTMLElement
  // a deep scroller: the virtualizer clamps its writes by the element's own
  // scrollHeight, which jsdom keeps at zero without an override
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 20000 })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 300 })
  // jsdom ships no Element.scrollTo, the write tanstack's elementScroll goes
  // through; mirror the browser's write so find navigation is exercisable
  Object.defineProperty(el, 'scrollTo', {
    configurable: true,
    value: (box: { top?: number }) => {
      if (box?.top !== undefined) el.scrollTop = box.top
    },
  })
  return {
    el,
    apply(next: AppliedSessionState) {
      current = next
      view.rerender(draw())
    },
    swap(nextId: string, next: AppliedSessionState) {
      id = nextId
      current = next
      view.rerender(draw())
    },
  }
}

// chainOf builds one rooted chain of count committed prompts and replies.
function chainOf(count: number): AppliedSessionState {
  const entries = Array.from({ length: count }, (_, i) =>
    messageEntry(
      `e${i}`,
      i === 0 ? undefined : `e${i - 1}`,
      i % 2 === 0 ? 'user' : 'assistant',
      `body ${i}`,
    ),
  )
  return applierReducer(initialSessionState(), {
    type: 'init',
    frame: initFrame(testState({ head: `e${count - 1}` }), entries),
  })
}

function openFind() {
  fireEvent.click(screen.getByRole('button', { name: 'Find in transcript' }))
  return screen.getByLabelText('Find query') as HTMLInputElement
}

function typeInto(box: HTMLInputElement, query: string) {
  fireEvent.change(box, { target: { value: query } })
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

// The stick fence: while following the tail the virtualizer's measurement
// corrections write scrollTop too, and one can land below the pinned tail
// mid-burst (its offsets lag the re-pins, and the live tail sits below the
// list it compensates for). Such a scroll event must never read as the user
// scrolling up: the pill stays hidden and growth keeps pinning the bottom,
// while wheel, touch and key scrolls still disengage.
describe('TranscriptView autoscroll intent', () => {
  // jsdom ships no observer, so every ResizeObserver under this render is
  // recorded and fired together, like one real resize batch
  function recordingRO() {
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
    return {
      fire: () => act(() => fireAll.forEach((fire) => fire())),
      restore: () => {
        globalThis.ResizeObserver = real
      },
    }
  }

  // the landing pin and its scroll event, so the direction check has a floor
  const landed = (el: HTMLElement) =>
    act(() => {
      el.scrollTop = el.scrollHeight
      el.dispatchEvent(new Event('scroll'))
    })

  it('keeps stick through a backward correction', () => {
    const ro = recordingRO()
    try {
      const el = renderTranscript()
      landed(el)
      expect(el.scrollTop).toBe(2000) // on the latest, stuck

      // a virtualizer correction writes scrollTop below the pinned tail: the
      // view is hundreds of px from the bottom it was just pinned to
      el.scrollTop = 1200
      act(() => {
        el.dispatchEvent(new Event('scroll'))
      })
      expect(screen.queryByText('↓ latest')).not.toBeInTheDocument()

      // growth after the correction still pins the stuck view to the new tail
      Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 2600 })
      ro.fire()
      expect(el.scrollTop).toBe(2600)
    } finally {
      ro.restore()
    }
  })

  it('disengages on a user wheel scroll', () => {
    const el = renderTranscript()
    landed(el)
    act(() => {
      fireEvent.wheel(el, { deltaY: -120 })
      el.scrollTop = 500
      el.dispatchEvent(new Event('scroll'))
    })
    expect(screen.getByText('↓ latest')).toBeInTheDocument()
  })

  it('disengages on a user touch drag', () => {
    const el = renderTranscript()
    landed(el)
    act(() => {
      fireEvent.touchStart(el, { touches: [{ clientY: 300 }] })
      fireEvent.touchMove(el, { touches: [{ clientY: 380 }] }) // finger down
      el.scrollTop = 500
      el.dispatchEvent(new Event('scroll'))
    })
    expect(screen.getByText('↓ latest')).toBeInTheDocument()
  })

  it('disengages on a scroll-away key', () => {
    const el = renderTranscript()
    landed(el)
    act(() => {
      fireEvent.keyDown(el, { key: 'PageUp' })
      el.scrollTop = 500
      el.dispatchEvent(new Event('scroll'))
    })
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

// The pending fence: one in-flight read disables the control with a progress
// label, a same-tick second activation cannot double-fire the cursor, and a
// settled read hands the control back for retries.
describe('TranscriptView load older pending', () => {
  function renderPending(loadOlder: () => Promise<LoadOlderResult>) {
    render(
      <TranscriptView
        sessionId="01TESTSESSION0000"
        state={unrootedState()}
        loadOlder={loadOlder}
        onThinkingToggle={() => {}}
      />,
    )
  }

  it('disables and reports progress while pending', async () => {
    let settle: ((result: LoadOlderResult) => void) | undefined
    let calls = 0
    renderPending(() => {
      calls++
      return new Promise<LoadOlderResult>((resolve) => {
        settle = resolve
      })
    })

    const idle = screen.getByRole('button', { name: 'Load older history' })
    fireEvent.click(idle)
    fireEvent.click(idle) // the synchronous guard keeps one request
    expect(calls).toBe(1)
    expect(screen.getByRole('button', { name: 'Loading older history…' })).toBeDisabled()

    settle?.({ kind: 'loaded' })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Load older history' })).toBeEnabled()
    })
  })

  it('hands the control back when a read fails', async () => {
    let settle: ((result: LoadOlderResult) => void) | undefined
    renderPending(
      () =>
        new Promise<LoadOlderResult>((resolve) => {
          settle = resolve
        }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Load older history' }))

    settle?.({ kind: 'failed', message: 'network down' })
    expect(await screen.findByText('network down')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load older history' })).toBeEnabled()
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

// The session-local find surface: counting, wrapping, empty state, scrolling
// unmounted virtual rows into view, and leaving the reader where they were
// when it closes. The pill's stuck state and the reader's location are the
// invariants a live transcript keeps touching.
describe('TranscriptView find', () => {
  it('exposes the Find control for touch surfaces', () => {
    render(
      <TranscriptView
        sessionId="01TESTSESSION0000"
        state={initialSessionState()}
        loadOlder={async () => ({ kind: 'dry' })}
        pullDownToLatest
        onThinkingToggle={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Find in transcript' })).toBeInTheDocument()
  })

  it('opens, counts, steps and wraps', () => {
    mountTranscript(chainOf(2))
    const box = openFind()
    typeInto(box, 'body')
    expect(screen.getByText('1/2')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Next match'))
    expect(screen.getByText('2/2')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Next match'))
    expect(screen.getByText('1/2')).toBeInTheDocument() // the end wraps to the first
    fireEvent.click(screen.getByLabelText('Previous match'))
    expect(screen.getByText('2/2')).toBeInTheDocument() // so does the start, backwards
  })

  it('keeps repeated hits in one row distinct', () => {
    const echoed = [
      messageEntry('e0', undefined, 'user', 'echo echo'),
      messageEntry('e1', 'e0', 'assistant', 'done'),
    ]
    mountTranscript(
      applierReducer(initialSessionState(), {
        type: 'init',
        frame: initFrame(testState({ head: 'e1' }), echoed),
      }),
    )
    const box = openFind()
    typeInto(box, 'echo')
    expect(screen.getByText('1/2')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Next match'))
    expect(screen.getByText('2/2')).toBeInTheDocument()
    // both hits share the row, distinct positions still shown
    expect(document.querySelector('[data-entry-id="e0"]')?.closest('.find-target')).not.toBeNull()
  })

  it('shows the empty-match state and resets on a query change', () => {
    mountTranscript(chainOf(2))
    const box = openFind()
    typeInto(box, 'zzz')
    expect(screen.getByText('no matches')).toBeInTheDocument()
    expect(screen.getByLabelText('Next match')).toBeDisabled()

    typeInto(box, 'body 1')
    expect(screen.getByText('1/1')).toBeInTheDocument()
    expect(screen.getByLabelText('Next match')).toBeEnabled()
  })

  it('navigates to an unmounted virtual row and marks it', async () => {
    const { el } = mountTranscript(chainOf(60))
    const box = openFind()
    typeInto(box, 'body 59')
    expect(screen.getByText('1/1')).toBeInTheDocument()
    expect(el.scrollTop).toBeGreaterThan(0) // the virtualizer wrote the scroll

    // jsdom fires no scroll event for the programmatic write, the browser
    // does: dispatch it so the window remounts around the target row
    act(() => {
      fireEvent.scroll(el)
    })
    await waitFor(() => expect(document.querySelector('[data-entry-id="e59"]')).not.toBeNull())
    expect(document.querySelector('[data-entry-id="e59"]')?.closest('.find-target')).not.toBeNull()
  })

  it('opening leaves the stuck state and closing keeps the reading spot', () => {
    const { el } = mountTranscript(chainOf(60))
    showPill(el)
    expect(screen.getByText('↓ latest')).toBeInTheDocument()

    const box = openFind()
    typeInto(box, 'body 59')
    expect(el.scrollTop).toBeGreaterThan(0)
    // navigating to the hit disengaged autoscroll honestly
    expect(screen.getByText('↓ latest')).toBeInTheDocument()

    const at = el.scrollTop
    fireEvent.click(screen.getByLabelText('Close find'))
    expect(screen.getByRole('button', { name: 'Find in transcript' })).toBeInTheDocument()
    expect(el.scrollTop).toBe(at) // closing preserved the reading location
  })

  it('live reconciliation keeps the reader on the active match', () => {
    const { apply } = mountTranscript(chainOf(2))
    const box = openFind()
    typeInto(box, 'body')
    expect(screen.getByText('1/2')).toBeInTheDocument()

    // a committed append joins the chain: the count refreshes truthfully and
    // the active match survives by identity, moving nobody
    const before = document.querySelector('.transcript-scroll')?.scrollTop ?? 0
    apply(
      applierReducer(chainOf(2), {
        type: 'event',
        event: ev('entry.append', 10, { entry: messageEntry('e2x', 'e1', 'user', 'body two') }),
      }),
    )
    expect(screen.getByText('1/3')).toBeInTheDocument()
    expect(document.querySelector('.transcript-scroll')?.scrollTop).toBe(before)
  })

  it('clears the selection when reconciliation empties the matches', () => {
    const { apply } = mountTranscript(chainOf(2))
    const box = openFind()
    typeInto(box, 'body 1')
    expect(screen.getByText('1/1')).toBeInTheDocument()

    // a rewind drops the matched row entirely: the surface shows its empty
    // state instead of holding a dead hit
    apply(
      applierReducer(chainOf(2), {
        type: 'event',
        event: ev('branch.changed', 10, { from: 'e1', head: 'e0', cause: 'rewind' }),
      }),
    )
    expect(screen.getByText('no matches')).toBeInTheDocument()
  })

  it('moves to the nearest survivor when a rewind drops the active hit', () => {
    const { apply } = mountTranscript(chainOf(3))
    const box = openFind()
    typeInto(box, 'body')
    fireEvent.click(screen.getByLabelText('Next match'))
    fireEvent.click(screen.getByLabelText('Next match'))
    expect(screen.getByText('3/3')).toBeInTheDocument()

    // the rewind drops e2, the active hit: the nearest survivor takes over
    // and the count stays truthful
    apply(
      applierReducer(chainOf(3), {
        type: 'event',
        event: ev('branch.changed', 10, { from: 'e2', head: 'e1', cause: 'rewind' }),
      }),
    )
    expect(screen.getByText('1/2')).toBeInTheDocument()
    expect(document.querySelector('[data-entry-id="e2"]')).toBeNull()
  })

  it('closes an open find on a session swap', () => {
    const { swap } = mountTranscript(chainOf(2))
    typeInto(openFind(), 'body')
    expect(screen.getByText('1/2')).toBeInTheDocument()

    swap('01OTHERSESSION0', chainOf(2))
    expect(screen.queryByLabelText('Find query')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Find in transcript' })).toBeInTheDocument()
  })
})

// Unread output: only real transcript content arriving while the view sits
// unstuck may raise the pill's label. Prepends, snapshots, measurement churn
// and stuck-view arrivals never do; sticking back and session swaps clear it.
describe('TranscriptView unread output', () => {
  function seeded(): AppliedSessionState {
    const e1 = messageEntry('e1', undefined, 'user', 'hello there')
    return applierReducer(initialSessionState(), {
      type: 'init',
      frame: initFrame(testState({ head: 'e1' }), [e1]),
    })
  }

  const withDelta = (): AppliedSessionState =>
    applierReducer(seeded(), { type: 'event', event: ev('text.delta', 1, { delta: 'streaming' }) })

  it('marks tail content while unstuck and clears on jump', () => {
    const { el, apply } = mountTranscript(seeded())
    showPill(el)
    expect(screen.getByText('↓ latest')).toBeInTheDocument()

    apply(withDelta())
    expect(screen.getByText('↓ New output')).toBeInTheDocument()

    // jumping home hides the pill; scrolling away again shows the tail pill
    // with no unread mark
    fireEvent.click(screen.getByText('↓ New output'))
    expect(screen.queryByText(/↓ /)).not.toBeInTheDocument()
    showPill(el)
    expect(screen.getByText('↓ latest')).toBeInTheDocument()
  })

  it('ignores prepends and snapshot churn', () => {
    const s0 = applierReducer(initialSessionState(), {
      type: 'init',
      frame: initFrame(testState({ head: 'e2' }), [
        entry('e2', 'e1', 'notice', { message: 'tail' }),
      ]),
    })
    const prepended = applierReducer(s0, {
      type: 'backfill',
      entries: [messageEntry('e1', undefined, 'user', 'older history')],
    })
    const snapshotted = applierReducer(prepended, {
      type: 'snapshot',
      state: testState({ seq: 50 }),
    })
    const { el, apply } = mountTranscript(s0)
    showPill(el)

    apply(prepended)
    expect(screen.getByText('↓ latest')).toBeInTheDocument()
    apply(snapshotted)
    expect(screen.getByText('↓ latest')).toBeInTheDocument()
  })

  it('stays quiet while stuck', () => {
    const { el, apply } = mountTranscript(seeded())
    apply(withDelta()) // stuck: the pill stays hidden, nothing is unread
    expect(screen.queryByText('↓ New output')).not.toBeInTheDocument()

    showPill(el)
    expect(screen.getByText('↓ latest')).toBeInTheDocument()
  })

  it('resets on a session swap', () => {
    const { el, apply, swap } = mountTranscript(seeded())
    showPill(el)
    apply(withDelta())
    expect(screen.getByText('↓ New output')).toBeInTheDocument()

    swap('01OTHERSESSION0', seeded())
    expect(screen.queryByText(/↓ /)).not.toBeInTheDocument()
    showPill(el)
    expect(screen.getByText('↓ latest')).toBeInTheDocument()
  })
})

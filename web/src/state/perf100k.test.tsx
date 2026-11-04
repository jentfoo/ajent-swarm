import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { applierReducer, initialSessionState } from './eventApplier'
import { TranscriptView } from '../session/TranscriptView'
import { initFrame, testState } from './testFixtures'
import type { Entry } from '../api/types'

// Phase 12 performance guard: one hundred thousand committed entries flow
// through the applier in one init, a burst of streamed deltas applies on top,
// and an older-history prepend re-roots the chain, all inside generous wall
// budgets. These bounds hold CI honest without measuring exact frames; the
// rendering side stays bounded by the virtualizer, which the SessionView
// long-transcript test covers.

// perfChain builds a single-parented chain of count entries, oldest first.
function perfChain(count: number): { entries: Entry[]; head: string } {
  const entries: Entry[] = new Array<Entry>(count)
  let parent: string | undefined = undefined
  for (let i = 0; i < count; i++) {
    const id = `01P${String(i).padStart(8, '0')}`
    const e: Entry = { id, type: 'message', ts: 1730000000000 + i }
    if (parent !== undefined) e.parentId = parent
    e.data = {
      message: {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', data: { text: `body ${i}` } }],
      },
    }
    entries[i] = e
    parent = id
  }
  return { entries, head: parent! }
}

describe('applier at 100k entries', () => {
  const count = 100_000

  it('ingests a full init inside the budget', () => {
    const { entries, head } = perfChain(count)

    const start = performance.now()
    const state = applierReducer(initialSessionState(), {
      type: 'init',
      frame: initFrame(testState({ head }), entries),
    })
    const elapsed = performance.now() - start

    expect(state.chain.ids.length).toBe(count)
    expect(state.chain.rooted).toBe(true)
    expect(state.chain.oldestId).toBe(entries[0].id)
    expect(state.entries.size).toBe(count)
    // generous bound: sanity against a pathological regression, not a
    // rendering benchmark
    expect(elapsed).toBeLessThan(10_000)
  })

  it('applies a streamed delta burst on the long chain', () => {
    const { entries, head } = perfChain(count)
    let state = applierReducer(initialSessionState(), {
      type: 'init',
      frame: initFrame(testState({ head }), entries),
    })

    // one long streaming turn over the settled history: 5k deltas apply
    // above the init watermark without re-deriving committed blocks
    const burst = 5_000
    const start = performance.now()
    for (let i = 0; i < burst; i++) {
      state = applierReducer(state, {
        type: 'event',
        event: { event: 'text.delta', seq: i + 1, data: { delta: 'x' } },
      })
    }
    const elapsed = performance.now() - start

    expect(state.seq).toBe(burst)
    expect(state.live?.text).toBe('x'.repeat(burst))
    expect(elapsed).toBeLessThan(10_000)
  })

  it('re-roots through an older-history prepend', () => {
    const { entries, head } = perfChain(count)
    // the init holds only the newest half, so the chain is unrooted
    const newer = entries.slice(count / 2)
    let state = applierReducer(initialSessionState(), {
      type: 'init',
      frame: initFrame(testState({ head }), newer),
    })
    expect(state.chain.rooted).toBe(false)
    expect(state.chain.ids.length).toBe(count / 2)

    // one backfill page delivers the older half and re-roots
    const start = performance.now()
    state = applierReducer(state, { type: 'backfill', entries: entries.slice(0, count / 2) })
    const elapsed = performance.now() - start

    expect(state.chain.rooted).toBe(true)
    expect(state.chain.ids.length).toBe(count)
    expect(state.chain.oldestId).toBe(entries[0].id)
    expect(elapsed).toBeLessThan(10_000)
  })

  it('renders the long chain through a bounded virtual window', () => {
    const { entries, head } = perfChain(count)
    const state = applierReducer(initialSessionState(), {
      type: 'init',
      frame: initFrame(testState({ head }), entries),
    })

    const start = performance.now()
    render(
      <div style={{ height: 600, overflow: 'auto' }}>
        <TranscriptView
          sessionId={head}
          state={state}
          loadOlder={async () => false}
          onThinkingToggle={() => {}}
        />
      </div>,
    )
    const elapsed = performance.now() - start

    // far fewer blocks paint than the chain holds; the DOM stays finite at
    // any transcript depth
    const rendered = document.querySelectorAll('[data-entry-id]').length
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(100)
    expect(elapsed).toBeLessThan(10_000)
  })
})

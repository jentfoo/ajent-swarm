import { describe, expect, it } from 'vitest'

import { barrierHold } from './barrierHold'
import type { LiveTurn } from '../state/eventApplier'

// The live tail under an open dialog: ajent serializes a batch that can prompt,
// so the first card without a result is the gated call and everything after it
// only queues behind the answer.

type Tool = LiveTurn['tools'][number]

function tool(id: string, over: Partial<Tool> = {}): Tool {
  return { id, name: 'bash', outputs: [], ...over }
}

function result(): NonNullable<Tool['result']> {
  return { output: 'done', error: false }
}

describe('barrierHold', () => {
  it.each([
    ['every call settled', [tool('c1', { result: result() })]],
    ['an unresolved tail', [tool('c1', { result: result() }), tool('c2')]],
  ])('shows every call without a dialog (%s)', (_name, tools) => {
    expect(barrierHold(tools, false)).toEqual({ shown: tools, held: 0 })
  })

  it('holds calls queued behind the gated one', () => {
    const tools = [
      tool('c1', { result: result() }),
      tool('c2', { input: { cmd: 'rm -rf build' } }),
      tool('c3'),
      tool('c4'),
    ]
    expect(barrierHold(tools, true)).toEqual({ shown: tools.slice(0, 2), held: 2 })
  })

  it('gates the first call when nothing settled yet', () => {
    const tools = [tool('c1'), tool('c2')]
    expect(barrierHold(tools, true)).toEqual({ shown: tools.slice(0, 1), held: 1 })
  })

  it('releases once every call settled', () => {
    const tools = [
      tool('c1', { result: result() }),
      tool('c2', { closed: true }), // the turn ended before its result arrived
    ]
    expect(barrierHold(tools, true)).toEqual({ shown: tools, held: 0 })
  })

  it('keeps staged shell cards painting across the cut', () => {
    const tools = [
      tool('s1', { shell: true, label: '! make test' }),
      tool('c1', { result: result() }),
      tool('c2'),
      tool('s2', { shell: true, label: '! ls' }),
      tool('c3'),
    ]
    expect(barrierHold(tools, true)).toEqual({
      shown: [tools[0], tools[1], tools[2], tools[3]],
      held: 1,
    })
  })

  it('releases when the gated call resolves and the next one opens', () => {
    // the answer landed, c2 runs now: the cut moves with the first unresolved
    const tools = [tool('c1', { result: result() }), tool('c2', { result: result() }), tool('c3')]
    expect(barrierHold(tools, true)).toEqual({ shown: tools.slice(0, 3), held: 0 })
    const next = [...tools, tool('c4')]
    expect(barrierHold(next, true)).toEqual({ shown: next.slice(0, 3), held: 1 })
  })

  it('holds nothing on an empty buffer', () => {
    expect(barrierHold([], true)).toEqual({ shown: [], held: 0 })
  })
})

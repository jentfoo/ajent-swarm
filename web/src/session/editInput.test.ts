import { describe, expect, it } from 'vitest'

import { parseEditInput } from './editInput'

// The parser mirrors ajent's decodeEditParams tolerance (pkg/tools/edit.go)
// anything that decoder would reject must parse to undefined so the card
// pretty-prints the raw input instead of a half-read diff.

describe('parseEditInput', () => {
  it('decodes the declared shape', () => {
    expect(
      parseEditInput({
        path: 'a.go',
        edits: [
          { oldText: 'one', newText: 'two' },
          { oldText: 'x', newText: 'y', replace_all: true },
        ],
      }),
    ).toEqual({
      path: 'a.go',
      ops: [
        { oldText: 'one', newText: 'two', replaceAll: false },
        { oldText: 'x', newText: 'y', replaceAll: true },
      ],
    })
  })

  it('unwraps string-encoded edits', () => {
    expect(parseEditInput({ path: 'a.go', edits: '[{"oldText":"a","newText":"b"}]' })).toEqual({
      path: 'a.go',
      ops: [{ oldText: 'a', newText: 'b', replaceAll: false }],
    })
  })

  it('unwraps a double-encoded argument object', () => {
    expect(parseEditInput('{"path":"a.go","edits":[{"oldText":"a","newText":"b"}]}')).toEqual({
      path: 'a.go',
      ops: [{ oldText: 'a', newText: 'b', replaceAll: false }],
    })
  })

  it('accepts a lone edit where an array is declared', () => {
    expect(parseEditInput({ path: 'a.go', edits: { oldText: 'a', newText: 'b' } })).toEqual({
      path: 'a.go',
      ops: [{ oldText: 'a', newText: 'b', replaceAll: false }],
    })
  })

  it('falls back without a string path', () => {
    expect(parseEditInput({ edits: [{ oldText: 'a', newText: 'b' }] })).toBeUndefined()
    expect(parseEditInput({ path: 3, edits: [{ oldText: 'a', newText: 'b' }] })).toBeUndefined()
  })

  it('falls back on wrong-kind op fields', () => {
    expect(parseEditInput({ path: 'a.go', edits: [{ oldText: 'a' }] })).toBeUndefined()
    expect(parseEditInput({ path: 'a.go', edits: [{ oldText: 'a', newText: 2 }] })).toBeUndefined()
    expect(parseEditInput({ path: 'a.go', edits: ['x'] })).toBeUndefined()
  })

  it('falls back on absent or empty edits', () => {
    expect(parseEditInput({ path: 'a.go' })).toBeUndefined()
    expect(parseEditInput({ path: 'a.go', edits: [] })).toBeUndefined()
    expect(parseEditInput({ path: 'a.go', edits: null })).toBeUndefined()
    expect(parseEditInput({ path: 'a.go', edits: 5 })).toBeUndefined()
  })

  it('falls back on non-object input', () => {
    expect(parseEditInput(3)).toBeUndefined()
    expect(parseEditInput('not json')).toBeUndefined()
    expect(parseEditInput('[{"oldText":"a"}]')).toBeUndefined()
    expect(parseEditInput(undefined)).toBeUndefined()
  })
})

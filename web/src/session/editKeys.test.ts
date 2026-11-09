import { describe, expect, it } from 'vitest'

import { killLineEnd, killLineStart, yank } from './editKeys'
import type { EditState } from './editKeys'

// at builds a state with a collapsed caret at pos, or a selection spanning
// pos..end.
function at(value: string, pos: number, end = pos): EditState {
  return { value, selectionStart: pos, selectionEnd: end }
}

describe('killLineEnd', () => {
  it('removes from the caret to the logical line end', () => {
    const res = killLineEnd(at('hello world', 5))
    expect(res?.next).toEqual(at('hello', 5))
    expect(res?.snapshot.restore).toEqual(at('hello world', 5))
    expect(res?.snapshot.expected).toBe('hello')
  })

  it('stops at the newline keeping the lines below', () => {
    expect(killLineEnd(at('ab\ncd', 3))?.next).toEqual(at('ab\n', 3))
    expect(killLineEnd(at('ab\ncd', 4))?.next).toEqual(at('ab\nc', 4))
  })

  it('joins the line below when the caret sits on a newline', () => {
    expect(killLineEnd(at('ab\ncd', 2))?.next).toEqual(at('abcd', 2))
    expect(killLineEnd(at('ab\n\ncd', 3))?.next).toEqual(at('ab\ncd', 3))
  })

  it('joins the line above from a trailing empty line', () => {
    expect(killLineEnd(at('abc\n', 4))?.next).toEqual(at('abc', 0))
    expect(killLineEnd(at('ab\ncd\n', 6))?.next).toEqual(at('ab\ncd', 3))
    expect(killLineEnd(at('\n', 1))?.next).toEqual(at('', 0))
  })

  it('removes nothing at the last line end or on an empty buffer', () => {
    expect(killLineEnd(at('abc', 3))).toBeUndefined()
    expect(killLineEnd(at('ab\ncd', 6))).toBeUndefined()
    expect(killLineEnd(at('', 0))).toBeUndefined()
  })

  it('collapses a selection to its start before killing', () => {
    expect(killLineEnd(at('hello world', 6, 11))?.next).toEqual(at('hello ', 6))
  })
})

describe('killLineStart', () => {
  it('removes from the line start to the caret, parking the caret there', () => {
    const res = killLineStart(at('hello world', 5))
    expect(res?.next).toEqual(at(' world', 0))
    expect(res?.snapshot.restore).toEqual(at('hello world', 5))
    expect(res?.snapshot.expected).toBe(' world')
  })

  it('starts after the newline above the caret', () => {
    expect(killLineStart(at('ab\ncd ef', 6))?.next).toEqual(at('ab\nef', 3))
  })

  it('kills a whole line to the value end', () => {
    expect(killLineStart(at('hello', 5))?.next).toEqual(at('', 0))
  })

  it('kills up to a newline without removing it', () => {
    expect(killLineStart(at('ab\ncd', 2))?.next).toEqual(at('\ncd', 0))
  })

  it('removes nothing at the line start', () => {
    expect(killLineStart(at('abc', 0))).toBeUndefined()
    expect(killLineStart(at('ab\ncd', 3))).toBeUndefined()
    expect(killLineStart(at('', 0))).toBeUndefined()
  })
})

describe('yank', () => {
  it('restores the buffer state the last kill left', () => {
    const before = at('hello world', 5)
    expect(yank(killLineEnd(before)?.snapshot)).toEqual(before)
  })

  it('restores nothing without a snapshot', () => {
    expect(yank(null)).toBeUndefined()
  })
})

describe('kill and yank snapshot lifecycle', () => {
  it('keeps an older snapshot through a kill that removes nothing', () => {
    const first = killLineStart(at('one two', 3))
    expect(first).toBeDefined()
    // the caret parks at the killed line's start: a second kill removes
    // nothing and must not overwrite the held snapshot
    expect(killLineStart(first!.next)).toBeUndefined()
    expect(yank(first!.snapshot)).toEqual(at('one two', 3))
  })

  it('replaces the snapshot on the next kill, one level deep', () => {
    const first = killLineEnd(at('one two', 3))!
    const second = killLineStart(first.next)!
    expect(second.next.value).toBe('')
    // only the second kill's pre-state remains restorable
    expect(yank(second.snapshot)).toEqual(first.next)
  })
})

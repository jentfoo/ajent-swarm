import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { resetDrafts } from './draftStore'
import { useComposerDraft } from './useComposerDraft'

describe('useComposerDraft', () => {
  beforeEach(() => {
    localStorage.clear()
    resetDrafts()
  })

  it('starts empty and writes every edit through to storage', () => {
    const { result } = renderHook(() => useComposerDraft('01A'))
    expect(result.current.draft).toBe('')

    act(() => result.current.setDraft('fix the bug'))
    expect(result.current.draft).toBe('fix the bug')
    resetDrafts() // re-read what storage actually holds
    const reread = renderHook(() => useComposerDraft('01A'))
    expect(reread.result.current.draft).toBe('fix the bug')
  })

  it('clears storage when the draft empties', () => {
    const first = renderHook(() => useComposerDraft('01A'))
    act(() => first.result.current.setDraft('alpha'))
    act(() => first.result.current.setDraft(''))
    resetDrafts()
    expect(renderHook(() => useComposerDraft('01A')).result.current.draft).toBe('')
  })

  it('restores a session swap before paint and keeps both texts', () => {
    const { result, rerender } = renderHook(({ id }) => useComposerDraft(id), {
      initialProps: { id: '01A' },
    })
    act(() => result.current.setDraft('alpha draft'))

    rerender({ id: '01B' })
    expect(result.current.draft).toBe('')
    act(() => result.current.setDraft('beta draft'))

    rerender({ id: '01A' })
    expect(result.current.draft).toBe('alpha draft')
  })

  it('prefills an empty composer by overwrite without a merge report', () => {
    const { result } = renderHook(() => useComposerDraft('01A'))
    let merged = true
    act(() => {
      merged = result.current.prefill('rewound prompt')
    })
    expect(result.current.draft).toBe('rewound prompt')
    expect(merged).toBe(false)
  })

  it('prepends above a non-empty draft with one newline', () => {
    const { result } = renderHook(() => useComposerDraft('01A'))
    act(() => result.current.setDraft('my draft'))
    let merged = false
    act(() => {
      merged = result.current.prefill('recalled prompt')
    })
    expect(result.current.draft).toBe('recalled prompt\nmy draft')
    expect(merged).toBe(true)
  })

  it('ignores empty prefill text entirely', () => {
    const { result } = renderHook(() => useComposerDraft('01A'))
    act(() => result.current.setDraft('my draft'))
    let merged = true
    act(() => {
      merged = result.current.prefill('')
    })
    expect(result.current.draft).toBe('my draft')
    expect(merged).toBe(false)
  })

  it('keeps repeated prefills in the same tick from losing text', () => {
    const { result } = renderHook(() => useComposerDraft('01A'))
    act(() => result.current.setDraft('mine'))
    act(() => {
      result.current.prefill('first')
      result.current.prefill('second')
    })
    expect(result.current.draft).toBe('second\nfirst\nmine')
  })
})

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCopyText } from './useCopyText'

// jsdom ships no clipboard; each file stubs it so the requirement stays
// visible at the call sites it covers
function stubClipboard(writeText: (text: string) => Promise<void>) {
  const fn = vi.fn(writeText)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: fn } })
  return fn
}

function unstubClipboard() {
  delete (navigator as { clipboard?: unknown }).clipboard
}

beforeEach(unstubClipboard)
afterEach(() => {
  unstubClipboard()
  vi.useRealTimers()
})

describe('useCopyText', () => {
  it('starts idle', () => {
    stubClipboard(async () => {})
    expect(renderHook(() => useCopyText()).result.current.state).toBe('idle')
  })

  it('flips copied then resolves back after the window', async () => {
    vi.useFakeTimers()
    stubClipboard(async () => {})
    const { result } = renderHook(() => useCopyText())

    await act(async () => result.current.copy('raw markdown'))
    expect(result.current.state).toBe('copied')

    act(() => vi.advanceTimersByTime(2_000))
    expect(result.current.state).toBe('idle')
  })

  it('reports failed on a rejected write', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')))
    const { result } = renderHook(() => useCopyText())

    await act(async () => result.current.copy('raw markdown'))
    expect(result.current.state).toBe('failed')
  })

  it('reports failed when no clipboard exists', () => {
    const { result } = renderHook(() => useCopyText())

    act(() => result.current.copy('raw markdown'))
    expect(result.current.state).toBe('failed')
  })

  it('keeps the newest copy winning when writes settle out of order', async () => {
    let rejectFirst: ((err: Error) => void) | undefined
    const writes = stubClipboard((text: string) => {
      if (text === 'first') return new Promise<void>((_, reject) => (rejectFirst = reject))
      return Promise.resolve()
    })
    const { result } = renderHook(() => useCopyText())

    act(() => result.current.copy('first'))
    await act(async () => result.current.copy('second'))
    expect(result.current.state).toBe('copied')

    // the first write rejecting late must not overwrite the later outcome
    await act(async () => rejectFirst?.(new Error('late failure')))
    expect(writes).toHaveBeenCalledTimes(2)
    expect(result.current.state).toBe('copied')
  })

  it('clears the resolve timer on unmount', async () => {
    vi.useFakeTimers()
    stubClipboard(async () => {})
    const { result, unmount } = renderHook(() => useCopyText())

    await act(async () => result.current.copy('raw markdown'))
    unmount()
    act(() => vi.advanceTimersByTime(10_000))
    expect(result.current.state).toBe('copied')
  })
})

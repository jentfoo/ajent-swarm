import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useArmedConfirm } from './useArmedConfirm'
import type { ArmedConfirmOptions } from './useArmedConfirm'

// The arm/confirm guard for destructive buttons: one click arms, the second
// confirms, and the timer, blur, any scroll, a disabled transition or fresh
// resetKey data disarms before the confirming click lands.

function scrollerScrolls() {
  const scroller = document.createElement('div')
  document.body.appendChild(scroller)
  act(() => {
    scroller.dispatchEvent(new Event('scroll'))
  })
  scroller.remove()
}

describe('useArmedConfirm', () => {
  const onConfirm = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    onConfirm.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function render(options?: ArmedConfirmOptions) {
    return renderHook(
      ({ disabled, resetKey }: ArmedConfirmOptions = {}) =>
        useArmedConfirm(onConfirm, { disabled, resetKey }),
      { initialProps: options },
    )
  }

  it('arms on the first click and confirms on the second', () => {
    const { result } = render()

    act(() => result.current.onClick())
    expect(result.current.armed).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()

    act(() => result.current.onClick())
    expect(result.current.armed).toBe(false)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('resets the arm once the window passes', () => {
    const { result } = render()

    act(() => result.current.onClick())
    act(() => vi.advanceTimersByTime(4_000))
    expect(result.current.armed).toBe(false)

    act(() => result.current.onClick())
    expect(result.current.armed).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('resets the arm on blur', () => {
    const { result } = render()

    act(() => result.current.onClick())
    act(() => result.current.onBlur())
    expect(result.current.armed).toBe(false)

    act(() => result.current.onClick())
    expect(result.current.armed).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('resets the arm on any scroll', () => {
    const { result } = render()

    act(() => result.current.onClick())
    scrollerScrolls()
    expect(result.current.armed).toBe(false)

    act(() => result.current.onClick())
    expect(result.current.armed).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('resets the arm when disabled transitions', () => {
    const { result, rerender } = render()

    act(() => result.current.onClick())
    rerender({ disabled: true })
    expect(result.current.armed).toBe(false)

    act(() => result.current.onClick())
    expect(result.current.armed).toBe(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('resets the arm when the reset key changes', () => {
    const { result, rerender } = render({ resetKey: { sessionId: '01A' } })

    act(() => result.current.onClick())
    // a poll rebuilds row objects even when the facts are unchanged
    rerender({ resetKey: { sessionId: '01A' } })
    expect(result.current.armed).toBe(false)

    act(() => result.current.onClick())
    expect(result.current.armed).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('keeps the arm while the reset key holds', () => {
    const row = { sessionId: '01A' }
    const { result, rerender } = render({ resetKey: row })

    act(() => result.current.onClick())
    rerender({ resetKey: row })
    expect(result.current.armed).toBe(true)

    act(() => result.current.onClick())
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('clears the pending timer on unmount', () => {
    const { result, unmount } = render()

    act(() => result.current.onClick())
    unmount()
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow()
  })
})

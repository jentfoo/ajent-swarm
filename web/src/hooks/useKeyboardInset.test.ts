import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useKeyboardInset } from './useKeyboardInset'

// The hook is exercised against a mocked visualViewport: resize and scroll
// events stand in for the keyboard's animation frames.

interface FakeVV extends EventTarget {
  height: number
  offsetTop: number
}

describe('useKeyboardInset', () => {
  let vv: FakeVV

  beforeEach(() => {
    vv = new EventTarget() as FakeVV
    vv.height = 800 // full viewport, no keyboard
    vv.offsetTop = 0
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: vv,
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'visualViewport')
  })

  function fire() {
    act(() => {
      vv.dispatchEvent(new Event('resize'))
      vv.dispatchEvent(new Event('scroll'))
    })
  }

  it('rises with each resize step while the keyboard animates', () => {
    const { result } = renderHook(() => useKeyboardInset())

    vv.height = 600 // keyboard partially shown
    fire()
    expect(result.current).toBe(200)

    vv.height = 300 // animation continues; every intermediate value lands
    fire()
    expect(result.current).toBe(500)
  })

  it('clamps negative insets to zero', () => {
    const { result } = renderHook(() => useKeyboardInset())

    vv.height = 900 // taller than the layout viewport mid-rotation or zoom
    fire()
    expect(result.current).toBe(0)
  })
})


import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useKeyboardInset } from './useKeyboardInset'

// The hook is exercised against a mocked visualViewport: resize and scroll
// events stand in for the keyboard's animation frames. An inset publishes only
// while page scale sits at 1 and an editable element holds focus, so tests
// seed the document with one focused input before shrinking the viewport.

interface FakeVV extends EventTarget {
  height: number
  offsetTop: number
  scale: number
}

describe('useKeyboardInset', () => {
  let vv: FakeVV

  beforeEach(() => {
    vv = new EventTarget() as FakeVV
    vv.height = 800 // full viewport, no keyboard
    vv.offsetTop = 0
    vv.scale = 1
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: vv,
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'visualViewport')
    Reflect.deleteProperty(window, 'scrollY')
    document.body.innerHTML = '' // drops the seeded editable
    vi.restoreAllMocks()
  })

  function fire() {
    act(() => {
      vv.dispatchEvent(new Event('resize'))
      vv.dispatchEvent(new Event('scroll'))
    })
  }

  // focusEditable seeds one focused input: an inset means a keyboard, and a
  // keyboard only exists while text entry holds the caret.
  function focusEditable(): HTMLInputElement {
    const input = document.createElement('input')
    document.body.appendChild(input)
    act(() => {
      input.focus()
    })
    return input
  }

  it('rises with each resize step while the keyboard animates', () => {
    focusEditable()
    const { result } = renderHook(() => useKeyboardInset())

    vv.height = 600 // keyboard partially shown
    fire()
    expect(result.current).toBe(200)

    vv.height = 300 // animation continues; every intermediate value lands
    fire()
    expect(result.current).toBe(500)
  })

  it('clamps negative insets to zero', () => {
    focusEditable()
    const { result } = renderHook(() => useKeyboardInset())

    vv.height = 900 // taller than the layout viewport mid-rotation or zoom
    fire()
    expect(result.current).toBe(0)
  })

  it('holds zero while nothing editable holds focus', () => {
    const { result } = renderHook(() => useKeyboardInset())

    vv.height = 300 // a keyboard-sized gap with no caret anywhere is not one
    fire()
    expect(result.current).toBe(0)

    focusEditable() // the tap that summons the keyboard also publishes it
    fire()
    expect(result.current).toBe(500)
  })

  it('drops once the editable loses focus', () => {
    const input = focusEditable()
    const { result } = renderHook(() => useKeyboardInset())

    vv.height = 300
    fire()
    expect(result.current).toBe(500)

    act(() => {
      input.blur() // the keyboard is on its way down
    })
    expect(result.current).toBe(0)
  })

  function panTo(y: number) {
    Object.defineProperty(window, 'scrollY', { configurable: true, value: y })
    return vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  }

  // WebKit's keyboard reveal pans the document itself when no inner scroller
  // can absorb it (bug 191204): the hook must keep the window pinned at
  // scrollTop zero while text entry holds the caret. jsdom leaves scrollY
  // undefined, so each case stubs it to a panned position.
  describe('document pan pinning', () => {
    it('resets a reveal pan while the caret holds', () => {
      focusEditable()
      renderHook(() => useKeyboardInset())

      const scrollTo = panTo(336)
      act(() => {
        window.dispatchEvent(new Event('scroll'))
      })
      expect(scrollTo).toHaveBeenCalledWith(0, 0)
    })

    it('un-pans a stuck view when the caret lands', () => {
      const scrollTo = panTo(336) // panned by an earlier keyboard session
      renderHook(() => useKeyboardInset())

      act(() => {
        focusEditable()
      })
      expect(scrollTo).toHaveBeenCalledWith(0, 0)
    })

    it('leaves the pan alone without a caret', () => {
      renderHook(() => useKeyboardInset())

      const scrollTo = panTo(336) // zoom pans and rubber bands stay untouched
      act(() => {
        window.dispatchEvent(new Event('scroll'))
      })
      expect(scrollTo).not.toHaveBeenCalled()
    })
  })

  it('suppresses the inset during a pinch zoom', () => {
    focusEditable()
    const { result } = renderHook(() => useKeyboardInset())

    vv.scale = 1.6 // mid-pinch: a shorter viewport, nothing keyboard-sized
    vv.height = 400
    fire()
    expect(result.current).toBe(0)

    vv.scale = 1 // the pinch settles and the real inset returns
    fire()
    expect(result.current).toBe(400)
  })
})

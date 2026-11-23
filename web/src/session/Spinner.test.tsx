import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Spinner } from './Spinner'

// The accessible contract: one stable sr-only state word names the spinner
// and the animated glyph is hidden decoration, so no animation frame ever
// re-announces. Reduced motion holds the first frame and stands the interval
// down, tracking a runtime preference change.

const frameMs = 90
const glyph = () => document.querySelector('.spinner [aria-hidden="true"]')!.textContent

// reducedMotion stubs a mutable prefers-reduced-motion query: set() flips
// matches and fires the change listeners useMediaQuery subscribes through.
function reducedMotion(matches: boolean) {
  const listeners = new Set<() => void>()
  const mql = {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb),
  }
  vi.stubGlobal('matchMedia', (query: string) =>
    query === mql.media
      ? (mql as unknown as MediaQueryList)
      : ({
          matches: false,
          media: query,
          onchange: null,
          addEventListener() {},
          removeEventListener() {},
        } as unknown as MediaQueryList),
  )
  return {
    set(next: boolean) {
      mql.matches = next
      listeners.forEach((cb) => cb())
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Spinner', () => {
  it('names the state once while the glyph spins', () => {
    vi.useFakeTimers()
    render(<Spinner state="wait" />)

    expect(screen.getByText('working')).toBeInTheDocument()
    expect(glyph()).toBe('⠦')
    const spinner = document.querySelector('.spinner')!
    expect(spinner).not.toHaveAttribute('role')
    expect(spinner).not.toHaveAttribute('aria-label')

    // the glyph advances while the accessible text node never moves
    const stateText = screen.getByText('working')
    act(() => vi.advanceTimersByTime(frameMs * 2))
    expect(glyph()).toBe('⠇')
    expect(screen.getByText('working')).toBe(stateText)
  })

  it('reads idle statically', () => {
    render(<Spinner state="idle" />)

    expect(screen.getByText('idle')).toBeInTheDocument()
    expect(glyph()).toBe('⠦')
  })

  it('holds a static glyph without an interval under reduced motion', () => {
    vi.useFakeTimers()
    reducedMotion(true)
    render(<Spinner state="stream" />)

    act(() => vi.advanceTimersByTime(frameMs * 5))
    expect(glyph()).toBe('⠦') // the first frame, never advanced
    expect(screen.getByText('working')).toBeInTheDocument()
  })

  it('follows a runtime preference change', () => {
    vi.useFakeTimers()
    const motion = reducedMotion(false)
    render(<Spinner state="wait" />)

    act(() => vi.advanceTimersByTime(frameMs))
    expect(glyph()).toBe('⠧')

    act(() => motion.set(true))
    expect(glyph()).toBe('⠦') // the static working frame
    act(() => vi.advanceTimersByTime(frameMs * 3))
    expect(glyph()).toBe('⠦') // the interval stood down

    act(() => motion.set(false))
    act(() => vi.advanceTimersByTime(frameMs))
    expect(glyph()).not.toBe('⠦') // the animation resumed
  })
})

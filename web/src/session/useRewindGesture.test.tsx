import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import type { ReactElement } from 'react'

import { useRewindGesture } from './useRewindGesture'
import type { UseRewindGestureOptions } from './useRewindGesture'
import { MenuPopover } from '../ui/MenuPopover'
import { ModalShell } from '../ui/ModalShell'

// The key binding lives at window level and every guard reads a mirror of the
// latest options, so each case mounts one config and dispatches Escape
// directly. A stubbed clock moves the two presses inside and outside the
// window deterministically, no fake timers needed.

const rewindWindowMs = 400

function Harness(props: UseRewindGestureOptions): ReactElement | null {
  useRewindGesture(props)
  return null
}

// one popover anchored to a real trigger, the way production opens one
function PopoverLayer(): ReactElement {
  const anchor = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={anchor} type="button">
        trigger
      </button>
      <MenuPopover anchorRef={anchor} onClose={() => {}}>
        menu
      </MenuPopover>
    </>
  )
}

// Escape on window, the return reports whether the hook claimed the press.
function escape(modifiers: KeyboardEventInit = {}): boolean {
  const ev = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
    ...modifiers,
  })
  window.dispatchEvent(ev)
  return ev.defaultPrevented
}

function key(k: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
}

describe('useRewindGesture', () => {
  let clock = 1_000_000
  const onRewind = vi.fn()

  beforeEach(() => {
    clock = 1_000_000
    onRewind.mockReset()
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function mount(overrides: Partial<UseRewindGestureOptions> = {}, layer?: ReactElement) {
    return render(
      <>
        <Harness idle onRewind={onRewind} {...overrides} />
        {layer}
      </>,
    )
  }

  it('rewinds on two quick escapes', () => {
    mount()

    expect(escape()).toBe(false) // the first press keeps its other meanings
    clock += rewindWindowMs - 1
    expect(escape()).toBe(true) // the second press is the gesture's own
    expect(onRewind).toHaveBeenCalledOnce()
  })

  it('re-arms when the second press misses the window', () => {
    mount()

    escape()
    clock += rewindWindowMs + 1
    expect(escape()).toBe(false) // too slow: re-arm, never fire
    expect(onRewind).not.toHaveBeenCalled()

    clock += 10
    expect(escape()).toBe(true)
    expect(onRewind).toHaveBeenCalledOnce()
  })

  it('ends the window on any other key', () => {
    mount()

    escape()
    key('x')
    clock += 10
    expect(escape()).toBe(false)
    expect(onRewind).not.toHaveBeenCalled()
  })

  it('ignores modified escapes', () => {
    mount()

    expect(escape({ ctrlKey: true })).toBe(false)
    expect(escape({ metaKey: true })).toBe(false)
    expect(escape({ altKey: true })).toBe(false)
    clock += 10
    expect(escape()).toBe(false) // armed fresh, nothing fired yet
    expect(onRewind).not.toHaveBeenCalled()
  })

  it('respects a claim made before it', () => {
    mount()

    // e.g. the composer hiding its @-menu preventDefaults first
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    ev.preventDefault()
    window.dispatchEvent(ev)
    expect(onRewind).not.toHaveBeenCalled()

    clock += 10
    expect(escape()).toBe(false) // the claimed press armed nothing
    expect(onRewind).not.toHaveBeenCalled()
  })

  it('stands down while a modal shell holds the screen', () => {
    mount(
      {},
      <ModalShell label="Test dialog" onClose={() => {}}>
        <p>body</p>
      </ModalShell>,
    )

    expect(escape()).toBe(false)
    clock += 10
    expect(escape()).toBe(false)
    expect(onRewind).not.toHaveBeenCalled()
  })

  it('stands down while a popover menu is open', () => {
    mount({}, <PopoverLayer />)

    expect(escape()).toBe(false)
    clock += 10
    expect(escape()).toBe(false)
    expect(onRewind).not.toHaveBeenCalled()
  })

  it('drops the arm when the session stops being idle', () => {
    const view = mount()
    escape()

    view.rerender(<Harness idle={false} onRewind={onRewind} />)
    clock += 10
    expect(escape()).toBe(false) // the mid-turn press interrupts elsewhere
    expect(onRewind).not.toHaveBeenCalled()

    // idle again: the dropped arm needs a fresh pair, a lone press is not it
    view.rerender(<Harness idle onRewind={onRewind} />)
    clock += 10
    expect(escape()).toBe(false)
    expect(onRewind).not.toHaveBeenCalled()
  })

  it('drops the arm when the surface loses focus', () => {
    const view = mount()
    escape()

    // a tile pane switch unbinds the keys, back in focus needs a fresh pair
    view.rerender(<Harness idle onRewind={onRewind} enabled={false} />)
    view.rerender(<Harness idle onRewind={onRewind} />)
    clock += 10
    expect(escape()).toBe(false)
    expect(onRewind).not.toHaveBeenCalled()
  })

  it('leaves the keys to other surfaces when disabled', () => {
    mount({ enabled: false })

    expect(escape()).toBe(false)
    clock += 10
    expect(escape()).toBe(false)
    expect(onRewind).not.toHaveBeenCalled()
  })

  it('fires again for each fresh pair', () => {
    mount()

    escape()
    clock += 10
    escape()
    clock += 10
    escape()
    clock += 10
    escape()
    expect(onRewind).toHaveBeenCalledTimes(2)
  })
})

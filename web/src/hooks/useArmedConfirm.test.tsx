import { act, fireEvent, render as renderView, renderHook, screen } from '@testing-library/react'
import type { FocusEvent as ReactFocusEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useArmedConfirm } from './useArmedConfirm'
import type { ArmedConfirmOptions } from './useArmedConfirm'

// The arm/confirm guard for destructive buttons: one click arms, the second
// confirms, and the timer, a focus move onto another control, a disabled
// transition or fresh resetKey data disarms. Scroll voids the arm only once
// it carries the control out of view, document-level focus loss keeps it.

function scrollerScrolls() {
  const scroller = document.createElement('div')
  document.body.appendChild(scroller)
  act(() => {
    scroller.dispatchEvent(new Event('scroll'))
  })
  scroller.remove()
}

// HostButton mounts the hook the way callers do, so the arm binds to a real
// control whose viewport placement tests can move.
function HostButton({
  onConfirm,
  options,
}: {
  onConfirm: () => void
  options?: ArmedConfirmOptions
}) {
  const confirm = useArmedConfirm(onConfirm, options)
  return (
    <button type="button" onClick={confirm.onClick} onBlur={confirm.onBlur}>
      {confirm.armed ? 'Stop?' : 'Stop'}
    </button>
  )
}

// placeRect pins the armed button's box: 'in' shows inside the viewport,
// 'below' sits past its bottom edge.
function placeRect(button: HTMLElement, where: 'in' | 'below') {
  const rect = {
    width: 60,
    height: 40,
    left: 10,
    right: 70,
    top: where === 'in' ? 100 : window.innerHeight + 50,
    bottom: where === 'in' ? 140 : window.innerHeight + 90,
    x: 10,
    y: where === 'in' ? 100 : window.innerHeight + 50,
    toJSON: () => ({}),
  }
  return vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(rect as DOMRect)
}

describe('useArmedConfirm', () => {
  const onConfirm = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    onConfirm.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
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
    act(() => vi.advanceTimersByTime(10_000))
    expect(result.current.armed).toBe(false)

    act(() => result.current.onClick())
    expect(result.current.armed).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('holds the arm just inside the window', () => {
    const { result } = render()

    act(() => result.current.onClick())
    act(() => vi.advanceTimersByTime(9_999))
    expect(result.current.armed).toBe(true)

    act(() => result.current.onClick())
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('resets the arm on blur without a related target', () => {
    const { result } = render()

    act(() => result.current.onClick())
    // a direct call carries no event, so it reads as a plain reset
    act(() => result.current.onBlur())
    expect(result.current.armed).toBe(false)

    act(() => result.current.onClick())
    expect(result.current.armed).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('keeps the arm when focus leaves the document', () => {
    const { result } = render()

    act(() => result.current.onClick())
    // alt-tab or a focus-follows-mouse crossing fires focusout with a null target
    act(() =>
      result.current.onBlur({ relatedTarget: null } as unknown as ReactFocusEvent<HTMLElement>),
    )
    expect(result.current.armed).toBe(true)
  })

  it('resets the arm when focus lands on another control', () => {
    const { result } = render()

    act(() => result.current.onClick())
    act(() =>
      result.current.onBlur({
        relatedTarget: document.createElement('input'),
      } as unknown as ReactFocusEvent<HTMLElement>),
    )
    expect(result.current.armed).toBe(false)
  })

  it('keeps the arm across scrolls that leave the control in view', () => {
    renderView(<HostButton onConfirm={onConfirm} />)
    const stop = screen.getByRole('button', { name: 'Stop' })

    act(() => fireEvent.click(stop))
    const armed = screen.getByRole('button', { name: 'Stop?' })
    placeRect(armed, 'in')

    // a wheel tick or momentum tail: the scroller moved, the button did not leave
    scrollerScrolls()
    expect(screen.getByRole('button', { name: 'Stop?' })).toBeInTheDocument()

    act(() => fireEvent.click(screen.getByRole('button', { name: 'Stop?' })))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('keeps the arm when the window itself loses focus', () => {
    renderView(
      <>
        <HostButton onConfirm={onConfirm} />
        <input aria-label="elsewhere" />
      </>,
    )
    const stop = screen.getByRole('button', { name: 'Stop' })

    act(() => {
      stop.focus()
      fireEvent.click(stop)
    })
    expect(screen.getByRole('button', { name: 'Stop?' })).toBeInTheDocument()

    // a real focusout with nowhere in-document to land: alt-tab, another monitor
    act(() => fireEvent.focusOut(screen.getByRole('button', { name: 'Stop?' })))
    expect(screen.getByRole('button', { name: 'Stop?' })).toBeInTheDocument()

    act(() => fireEvent.click(screen.getByRole('button', { name: 'Stop?' })))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('resets the arm when focus moves to a sibling control', () => {
    renderView(
      <>
        <HostButton onConfirm={onConfirm} />
        <input aria-label="elsewhere" />
      </>,
    )
    const stop = screen.getByRole('button', { name: 'Stop' })

    act(() => {
      stop.focus()
      fireEvent.click(stop)
    })
    expect(screen.getByRole('button', { name: 'Stop?' })).toBeInTheDocument()

    act(() =>
      fireEvent.focusOut(screen.getByRole('button', { name: 'Stop?' }), {
        relatedTarget: screen.getByLabelText('elsewhere'),
      }),
    )
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('resets the arm once a scroll carries the control out of view', () => {
    renderView(<HostButton onConfirm={onConfirm} />)
    const stop = screen.getByRole('button', { name: 'Stop' })

    act(() => fireEvent.click(stop))
    placeRect(screen.getByRole('button', { name: 'Stop?' }), 'below')

    scrollerScrolls()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()

    act(() => fireEvent.click(screen.getByRole('button', { name: 'Stop' })))
    expect(screen.getByRole('button', { name: 'Stop?' })).toBeInTheDocument()
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
})

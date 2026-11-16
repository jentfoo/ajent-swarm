import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MenuPopover } from '../ui/MenuPopover'
import { ModalShell } from '../ui/ModalShell'
import { dialogDigitsClaimed, useDialogAnswerKeys } from './dialogKeys'

// Digits 1..9 answer a focused pane's head options card: plain presses only,
// never a caret's digits, never behind an overlay, and never a press another
// listener already claimed. While a claim is live the workspace's digit jumps
// stand down through dialogDigitsClaimed.

function Harness({
  enabled,
  answer,
  overlay,
}: {
  enabled: boolean
  answer: (position: number) => void
  overlay?: 'modal' | 'popover'
}) {
  useDialogAnswerKeys(enabled, answer)
  if (overlay === 'modal') {
    return (
      <ModalShell label="Cover" onClose={() => {}}>
        <p>body</p>
      </ModalShell>
    )
  }
  if (overlay === 'popover') {
    return (
      <MenuPopover anchorRef={{ current: null }} onClose={() => {}}>
        item
      </MenuPopover>
    )
  }
  return null
}

function press(init: KeyboardEventInit = {}): boolean {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(ev)
  return ev.defaultPrevented
}

describe('useDialogAnswerKeys', () => {
  it('answers digits one through nine while enabled', () => {
    const answer = vi.fn()
    render(<Harness enabled answer={answer} />)
    expect(press({ key: '1' })).toBe(true)
    expect(press({ key: '9' })).toBe(true)
    expect(press({ key: '0' })).toBe(false) // not an option position
    expect(answer.mock.calls).toEqual([[1], [9]])
  })

  it('claims the digits only while enabled', () => {
    const answer = vi.fn()
    const view = render(<Harness enabled={false} answer={answer} />)
    expect(dialogDigitsClaimed()).toBe(false)
    press({ key: '2' })
    expect(answer).not.toHaveBeenCalled()

    view.rerender(<Harness enabled answer={answer} />)
    expect(dialogDigitsClaimed()).toBe(true)
    view.rerender(<Harness enabled={false} answer={answer} />)
    expect(dialogDigitsClaimed()).toBe(false)
  })

  it('leaves modified and non-digit keys alone', () => {
    const answer = vi.fn()
    render(<Harness enabled answer={answer} />)
    expect(press({ key: '3', ctrlKey: true })).toBe(false)
    expect(press({ key: '3', metaKey: true })).toBe(false)
    expect(press({ key: '3', altKey: true })).toBe(false)
    expect(press({ key: 'j' })).toBe(false)
    expect(answer).not.toHaveBeenCalled()
  })

  it('yields a press another listener already claimed', () => {
    const answer = vi.fn()
    window.addEventListener('keydown', (ev) => ev.preventDefault(), { once: true })
    render(<Harness enabled answer={answer} />)
    expect(press({ key: '2' })).toBe(true) // the earlier claim stands
    expect(answer).not.toHaveBeenCalled()
  })

  it('keeps digits for a caret in an input', () => {
    const answer = vi.fn()
    render(<Harness enabled answer={answer} />)
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }))
    expect(answer).not.toHaveBeenCalled()
    input.remove()
  })

  it('rests behind an open modal or popover', () => {
    const answer = vi.fn()
    const modal = render(<Harness enabled answer={answer} overlay="modal" />)
    expect(press({ key: '2' })).toBe(false)
    modal.unmount()

    render(<Harness enabled answer={answer} overlay="popover" />)
    expect(press({ key: '2' })).toBe(false)
    expect(answer).not.toHaveBeenCalled()
  })

  it('lets only the topmost claim answer', () => {
    const answers = [vi.fn(), vi.fn()]
    function Probe({ index }: { index: number }) {
      useDialogAnswerKeys(true, (position) => answers[index]!(position))
      return null
    }
    render(
      <div>
        <Probe index={0} />
        <Probe index={1} />
      </div>,
    )
    press({ key: '4' })
    expect(answers[1]).toHaveBeenCalledWith(4)
    expect(answers[0]).not.toHaveBeenCalled()
  })

  it('releases its claim on unmount', () => {
    const view = render(<Harness enabled answer={() => {}} />)
    view.unmount()
    expect(dialogDigitsClaimed()).toBe(false)
  })
})

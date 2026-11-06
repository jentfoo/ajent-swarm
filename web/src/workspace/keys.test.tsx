import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ModalShell } from '../ui/ModalShell'
import { useDialogAnswerKeys } from '../session/dialogKeys'
import { useWorkspaceKeys } from './keys'
import type { WorkspaceKeyHandlers } from './keys'

// The hook binds window keydown; events dispatch with a cancelable event so
// each preventDefault claim shows up in defaultPrevented. Shifted keys carry
// their produced character ('|') and only ev.code names the physical key.

function Harness(props: WorkspaceKeyHandlers & { modal?: boolean; dialogDigits?: boolean }) {
  useWorkspaceKeys(props)
  useDialogAnswerKeys(props.dialogDigits === true, () => {})
  if (props.modal !== true) return null
  return (
    <ModalShell label="Test dialog" onClose={() => {}}>
      <p>body</p>
    </ModalShell>
  )
}

function mount(props: WorkspaceKeyHandlers) {
  return render(<Harness {...props} />)
}

function press(init: KeyboardEventInit = {}): boolean {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(ev)
  return ev.defaultPrevented
}

// Types into target so the event reaches window bubbling from an editable
// element.
function pressOn(target: Element, init: KeyboardEventInit = {}): boolean {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(ev)
  return ev.defaultPrevented
}

describe('useWorkspaceKeys', () => {
  it('splits down through the shifted pipe character', () => {
    const handlers = { onSplitDown: vi.fn(), onSplitRight: vi.fn() }
    mount(handlers)

    // with Shift held browsers report '|' as the key; only ev.code still
    // names the backslash, so this is what makes Mod+Shift+\ reachable
    expect(press({ key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true })).toBe(true)
    expect(handlers.onSplitDown).toHaveBeenCalledOnce()
    expect(handlers.onSplitRight).not.toHaveBeenCalled()
  })

  it('splits right on the plain backslash', () => {
    const handlers = { onSplitDown: vi.fn(), onSplitRight: vi.fn() }
    mount(handlers)

    expect(press({ key: '\\', code: 'Backslash', ctrlKey: true })).toBe(true)
    expect(handlers.onSplitRight).toHaveBeenCalledOnce()
    expect(handlers.onSplitDown).not.toHaveBeenCalled()
  })

  it('prevents default on handled plain keys', () => {
    const handlers = { onNext: vi.fn(), onOpen: vi.fn(), onReview: vi.fn() }
    mount(handlers)

    // Enter must not also activate a focused control behind the shortcut
    expect(press({ key: 'Enter' })).toBe(true)
    expect(handlers.onOpen).toHaveBeenCalledOnce()
    expect(press({ key: 'j' })).toBe(true)
    expect(press({ key: 'r' })).toBe(true)
  })

  it('keeps defaults for unclaimed plain keys', () => {
    const onReview = vi.fn() // Enter and the digits stay unbound here
    mount({ onReview })

    expect(press({ key: 'Enter' })).toBe(false)
    expect(press({ key: '3' })).toBe(false)
    expect(onReview).not.toHaveBeenCalled()
  })

  it('passes digit positions one through nine', () => {
    const onDigit = vi.fn()
    mount({ onDigit })

    expect(press({ key: '4' })).toBe(true)
    expect(onDigit).toHaveBeenCalledWith(4)
    expect(press({ key: '0' })).toBe(false) // 0 is not a binding
    expect(onDigit).toHaveBeenCalledOnce()
  })

  it('still prevents the modifier bindings without shift', () => {
    const handlers = { onPaneClose: vi.fn(), onFocusDirection: vi.fn() }
    mount(handlers)

    expect(press({ key: 'w', ctrlKey: true })).toBe(true)
    expect(press({ key: 'ArrowLeft', metaKey: true })).toBe(true)
  })

  it('leaves editable targets to the browser', () => {
    const onNext = vi.fn()
    const { container } = mount({ onNext })
    const input = document.createElement('input')
    container.appendChild(input)
    input.focus()

    expect(pressOn(input, { key: 'j' })).toBe(false)
    expect(onNext).not.toHaveBeenCalled()
  })

  it('stands down while a modal shell holds the screen', () => {
    const handlers = { onNext: vi.fn(), onEscape: vi.fn(), onShortcuts: vi.fn() }
    const view = render(<Harness {...handlers} />)

    // every binding rests behind the backdrop, leaving keys to the dialog
    view.rerender(<Harness {...handlers} modal />)
    expect(press({ key: 'j' })).toBe(false)
    expect(press({ key: '?' })).toBe(false)
    expect(press({ key: 'Escape' })).toBe(false)
    expect(handlers.onNext).not.toHaveBeenCalled()
    expect(handlers.onShortcuts).not.toHaveBeenCalled()

    view.rerender(<Harness {...handlers} />)
    expect(press({ key: 'j' })).toBe(true) // bindings return once it closes
  })

  it('stands down behind an event another listener claimed', () => {
    const handlers = { onEscape: vi.fn(), onNext: vi.fn() }
    mount(handlers)

    // e.g. the viewed session's Escape interrupt claimed the press first
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    ev.preventDefault()
    window.dispatchEvent(ev)

    expect(handlers.onEscape).not.toHaveBeenCalled()

    expect(press({ key: 'j' })).toBe(true) // unclaimed keys keep their bindings
  })

  it('rests its digits while a head dialog answers them', () => {
    const onDigit = vi.fn()
    const onNext = vi.fn()
    const view = render(<Harness onDigit={onDigit} onNext={onNext} />)

    expect(press({ key: '4' })).toBe(true) // no claim yet: the jump fires
    expect(onDigit).toHaveBeenCalledWith(4)

    // the focused pane's head options card claims the digits
    view.rerender(<Harness onDigit={onDigit} onNext={onNext} dialogDigits />)
    onDigit.mockClear()
    expect(press({ key: '4' })).toBe(true) // claimed by the dialog, not a jump
    expect(onDigit).not.toHaveBeenCalled()
    // only the digits rest; the rest of the workspace keeps its keys
    expect(press({ key: 'j' })).toBe(true)
    expect(onNext).toHaveBeenCalledOnce()

    view.rerender(<Harness onDigit={onDigit} onNext={onNext} />)
    expect(press({ key: '4' })).toBe(true)
    expect(onDigit).toHaveBeenCalledWith(4)
  })
})

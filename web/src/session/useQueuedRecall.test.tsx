import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

import { useQueuedRecall } from './useQueuedRecall'
import type { UseQueuedRecallOptions } from './useQueuedRecall'
import { MenuPopover } from '../ui/MenuPopover'
import { ModalShell } from '../ui/ModalShell'

// The key binding lives at window level and every guard reads a mirror of the
// latest options, so each case mounts one config and presses Alt+ArrowUp on an
// editable target directly. The setup's matchMedia stub reports fine pointers.

type HarnessProps = UseQueuedRecallOptions & { modal?: boolean; popover?: boolean }

function Harness(props: HarnessProps): ReactElement {
  const { modal, popover, ...opts } = props
  useQueuedRecall(opts)
  return (
    <>
      <textarea aria-label="Prompt" />
      {popover === true && (
        <MenuPopover anchorRef={{ current: null }} onClose={() => {}}>
          menu
        </MenuPopover>
      )}
      {modal === true && (
        <ModalShell label="Test dialog" onClose={() => {}}>
          <p>body</p>
        </ModalShell>
      )}
    </>
  )
}

// Alt+ArrowUp dispatched on the given target, reports whether the hook claimed
// the press.
function altUp(target: EventTarget = window, modifiers: KeyboardEventInit = {}): boolean {
  const ev = new KeyboardEvent('keydown', {
    key: 'ArrowUp',
    altKey: true,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  })
  target.dispatchEvent(ev)
  return ev.defaultPrevented
}

function mount(overrides: Partial<HarnessProps> = {}) {
  const onRecall = vi.fn()
  const view = render(<Harness onRecall={onRecall} canRecall {...overrides} />)
  return { onRecall, ...view }
}

describe('useQueuedRecall', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('recalls from an editable target', () => {
    const view = mount()
    const area = view.getByLabelText('Prompt')
    area.focus()

    expect(altUp(area)).toBe(true)
    expect(view.onRecall).toHaveBeenCalledTimes(1)

    // repeat presses fire again: each pops the next-newest row
    expect(altUp(area)).toBe(true)
    expect(view.onRecall).toHaveBeenCalledTimes(2)
  })

  it('leaves unclaimed when nothing is queued', () => {
    const view = mount({ canRecall: false })
    const area = view.getByLabelText('Prompt')

    expect(altUp(area)).toBe(false)
    expect(view.onRecall).not.toHaveBeenCalled()
  })

  it('reads the latest options without rebinding', () => {
    const view = mount({ canRecall: true })
    const area = view.getByLabelText('Prompt')
    expect(altUp(area)).toBe(true)

    view.rerender(<Harness onRecall={view.onRecall} canRecall={false} />)
    expect(altUp(area)).toBe(false)
    expect(view.onRecall).toHaveBeenCalledTimes(1)

    view.rerender(<Harness onRecall={view.onRecall} canRecall />)
    expect(altUp(area)).toBe(true)
    expect(view.onRecall).toHaveBeenCalledTimes(2)
  })

  it('stands down outside editable targets', () => {
    const view = mount()

    expect(altUp(window)).toBe(false)
    expect(altUp(document.body)).toBe(false)
    expect(view.onRecall).not.toHaveBeenCalled()
  })

  it('ignores unmodified presses and other chords', () => {
    const view = mount()
    const area = view.getByLabelText('Prompt')

    expect(altUp(area, { altKey: false })).toBe(false) // plain ArrowUp
    expect(altUp(area, { key: 'ArrowDown' })).toBe(false)
    expect(altUp(area, { ctrlKey: true })).toBe(false)
    expect(altUp(area, { metaKey: true })).toBe(false)
    expect(altUp(area, { shiftKey: true })).toBe(false)
    expect(view.onRecall).not.toHaveBeenCalled()
  })

  it('respects prior claims', () => {
    const view = mount()
    const area = view.getByLabelText('Prompt')

    // e.g. the composer's own key routing preventDefaults first
    const ev = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      altKey: true,
      bubbles: true,
      cancelable: true,
    })
    ev.preventDefault()
    area.dispatchEvent(ev)

    expect(view.onRecall).not.toHaveBeenCalled()
  })

  it('stands down behind open layers', () => {
    const modal = mount({ modal: true })
    expect(altUp(modal.getByLabelText('Prompt'))).toBe(false)
    expect(modal.onRecall).not.toHaveBeenCalled()
    modal.unmount()

    const popover = mount({ popover: true })
    expect(altUp(popover.getByLabelText('Prompt'))).toBe(false)
    expect(popover.onRecall).not.toHaveBeenCalled()
  })

  it('unbinds while disabled', () => {
    const view = mount({ enabled: false })
    const area = view.getByLabelText('Prompt')

    expect(altUp(area)).toBe(false)
    expect(view.onRecall).not.toHaveBeenCalled()
  })

  it('never binds on touch devices', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
    }))
    const view = mount()
    const area = view.getByLabelText('Prompt')
    area.focus()

    expect(altUp(area)).toBe(false)
    expect(view.onRecall).not.toHaveBeenCalled()
  })
})

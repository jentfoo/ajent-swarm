import { act, render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

import { useInterruptStream } from './useInterruptStream'
import type { UseInterruptStreamOptions } from './useInterruptStream'
import { MenuPopover } from '../ui/MenuPopover'
import { ModalShell } from '../ui/ModalShell'

// The key binding lives at window level and every guard reads a mirror of the
// latest options, so each case mounts one config and dispatches Escape
// directly, a deferred fetch lets one case hold a request on the wire.

const VIEW = '01ESCTEST000000'

type HarnessProps = UseInterruptStreamOptions & { modal?: boolean; popover?: boolean }

function Harness(props: HarnessProps): ReactElement {
  const { interrupt } = useInterruptStream(props)
  return (
    <>
      <button type="button" onClick={interrupt}>
        stop
      </button>
      {props.popover === true && (
        <MenuPopover anchorRef={{ current: null }} onClose={() => {}}>
          menu
        </MenuPopover>
      )}
      {props.modal === true && (
        <ModalShell label="Test dialog" onClose={() => {}}>
          <p>body</p>
        </ModalShell>
      )}
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

function interruptCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/interrupt')).length
}

describe('useInterruptStream', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockReturnValue(Response.json({ stopped: VIEW }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mount(overrides: Partial<HarnessProps> = {}) {
    return render(<Harness sessionId={VIEW} busy onToast={() => {}} {...overrides} />)
  }

  it('interrupts a running stream on escape', () => {
    mount()

    expect(escape()).toBe(true)
    expect(interruptCalls(fetchMock)).toBe(1)
  })

  it('claims the press, so later bindings stand down', () => {
    const later = vi.fn()
    window.addEventListener('keydown', later)

    mount()
    escape()
    window.removeEventListener('keydown', later)

    // a later listener still sees the event, already claimed: workspace
    // Escape bindings reading defaultPrevented leave it alone
    expect(later).toHaveBeenCalledTimes(1)
    expect(later.mock.calls[0][0].defaultPrevented).toBe(true)
  })

  it('leaves escape unclaimed while idle', () => {
    mount({ busy: false })

    expect(escape()).toBe(false)
    expect(interruptCalls(fetchMock)).toBe(0)
  })

  it('ignores modified escapes', () => {
    mount()

    expect(escape({ ctrlKey: true })).toBe(false)
    expect(escape({ metaKey: true })).toBe(false)
    expect(escape({ altKey: true })).toBe(false)
    expect(interruptCalls(fetchMock)).toBe(0)
  })

  it('respects a claim made before it', () => {
    mount()

    // e.g. the composer hiding its @-menu preventDefaults first
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    ev.preventDefault()
    window.dispatchEvent(ev)

    expect(interruptCalls(fetchMock)).toBe(0)
  })

  it('stands down while a modal shell holds the screen', () => {
    mount({ modal: true })

    expect(escape()).toBe(false)
    expect(interruptCalls(fetchMock)).toBe(0)
  })

  it('stands down while a popover menu is open', () => {
    mount({ popover: true })

    expect(escape()).toBe(false)
    expect(interruptCalls(fetchMock)).toBe(0)
  })

  it('leaves escape to other surfaces when disabled', () => {
    mount({ enabled: false })

    expect(escape()).toBe(false)
    expect(interruptCalls(fetchMock)).toBe(0)
  })

  it('swallows repeat presses while a request is unanswered', async () => {
    let release: ((value: Response) => void) | undefined
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve
      }),
    )
    mount()

    expect(escape()).toBe(true)
    expect(escape()).toBe(false) // already on the wire
    expect(interruptCalls(fetchMock)).toBe(1)

    await act(async () => {
      release?.(Response.json({ stopped: VIEW }))
    })
    expect(escape()).toBe(true) // freed once the reply lands
    expect(interruptCalls(fetchMock)).toBe(2)
  })

  it('fires from the exposed button the same way', async () => {
    const view = mount()
    const user = userEvent.setup()

    await user.click(view.getByText('stop'))
    expect(interruptCalls(fetchMock)).toBe(1)
  })

  it('toasts a refused interrupt', async () => {
    const onToast = vi.fn()
    fetchMock.mockReturnValueOnce(
      Response.json({ error: 'not_running', message: '' }, { status: 409 }),
    )
    const view = mount({ onToast })
    const user = userEvent.setup()

    await user.click(view.getByText('stop'))

    expect(onToast).toHaveBeenCalledWith('Interrupt failed.', 'error')
  })
})

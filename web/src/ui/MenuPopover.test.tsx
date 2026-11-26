import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MenuPopover, placeMenu } from './MenuPopover'

// The popover portals past overflow clipping into document.body, flips or
// clamps to stay in the viewport, and closes on Escape or an outside press:
// only the topmost of stacked popovers answers Escape, a press another
// listener claimed is left alone, and closing returns focus to the element
// focused before opening. jsdom has no layout: geometry is stubbed by class.

const baseAnchor = { top: 100, bottom: 124, left: 300, right: 360 }
let menuSize = { width: 200, height: 64 }

let anchorBox = baseAnchor

function rectFor(el: Element): Record<string, number> {
  if (el.classList.contains('popover-anchor')) return anchorBox
  if (el.classList.contains('popover-menu'))
    return { top: 0, bottom: menuSize.height, left: 0, right: menuSize.width }
  return { top: 0, bottom: 0, left: 0, right: 0 }
}

// jsdom's frame clock runs on real time, so the anchor sampler's ticks are
// queued and flushed by hand, one flush standing in for one paint
const rafCallbacks = new Map<number, FrameRequestCallback>()
let rafSeq = 0
const realRaf = window.requestAnimationFrame
const realCancelRaf = window.cancelAnimationFrame

function flushFrame() {
  const cbs = [...rafCallbacks.values()]
  rafCallbacks.clear()
  act(() => {
    cbs.forEach((cb) => cb(0))
  })
}

beforeEach(() => {
  anchorBox = baseAnchor
  menuSize = { width: 200, height: 64 }
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const r = rectFor(this)
    return {
      x: r.left,
      y: r.top,
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      width: r.right - r.left,
      height: r.bottom - r.top,
      toJSON: () => '',
    } as DOMRect
  })
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    rafSeq += 1
    rafCallbacks.set(rafSeq, cb)
    return rafSeq
  }
  window.cancelAnimationFrame = (id: number) => {
    rafCallbacks.delete(id)
  }
})

// the resize case pins innerHeight, restore the jsdom default between tests
const innerHeightDesc = Object.getOwnPropertyDescriptor(window, 'innerHeight')!

// FakeVV stands in for visualViewport, which jsdom ships none of: resize and
// scroll events plus geometry fields cover the keyboard's effect on placement.
interface FakeVV extends EventTarget {
  width: number
  height: number
  offsetTop: number
  offsetLeft: number
}

let vv: FakeVV

function stubViewport(
  props: Partial<{ width: number; height: number; offsetTop: number; offsetLeft: number }> = {},
) {
  vv = new EventTarget() as FakeVV
  Object.assign(vv, { width: 1024, height: 768, offsetTop: 0, offsetLeft: 0 }, props)
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv })
}

afterEach(() => {
  vi.restoreAllMocks()
  window.requestAnimationFrame = realRaf
  window.cancelAnimationFrame = realCancelRaf
  rafCallbacks.clear()
  Object.defineProperty(window, 'innerHeight', innerHeightDesc)
  Reflect.deleteProperty(window, 'visualViewport')
})

// Harness keeps the popover open beside a trigger under an overflow-clipped
// ancestor, the pane condition MenuPopover exists to escape. startOpen=false
// exercises the click-to-open flow so the trigger holds focus while opening
// label names trigger and menu together so stacked instances stay distinct.
function Harness({
  align = 'left',
  startOpen = true,
  label = 'trigger',
  matchWidth,
  restoreFocus,
  header,
}: {
  align?: 'left' | 'right'
  startOpen?: boolean
  label?: string
  matchWidth?: boolean
  restoreFocus?: boolean
  header?: ReactNode
}) {
  const [open, setOpen] = useState(startOpen)
  const anchorRef = useRef<HTMLButtonElement>(null)
  return (
    <div className="clip" style={{ overflow: 'hidden', padding: 8 }}>
      <button
        ref={anchorRef}
        type="button"
        className="popover-anchor"
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open && (
        <MenuPopover
          anchorRef={anchorRef}
          align={align}
          matchWidth={matchWidth}
          restoreFocus={restoreFocus}
          role="menu"
          aria-label={label}
          className="menu popover-menu"
          header={header}
          onClose={() => setOpen(false)}
        >
          <button type="button" role="menuitem">
            first item
          </button>
        </MenuPopover>
      )}
    </div>
  )
}

// layerOf is the positioned wrapper around a role element: placement, the
// caller's className and the mount measurement live there, the role sits inside
function layerOf(menu: HTMLElement): HTMLElement {
  return menu.parentElement as HTMLElement
}

describe('MenuPopover', () => {
  it('portals past a clipped ancestor into the body', () => {
    render(<Harness />)
    const menu = screen.getByRole('menu')
    // the layer is the body-level box carrying the caller's className, the role
    // element sits inside it with the caller's attributes
    const layer = layerOf(menu)
    expect(layer.parentElement).toBe(document.body)
    expect(layer.closest('.clip')).toBeNull()
    expect(layer).toHaveClass('popover-menu', 'pop-fade')
    expect(menu).toHaveAttribute('aria-label', 'trigger')
    expect(menu).not.toHaveClass('popover-menu')
  })

  it('lands placed on mount without transforming its box', () => {
    // the entrance is an opacity-only fade: a transform would move the box
    // this mount measurement reads, so none may ever sit on the layer
    render(<Harness />)
    const layer = layerOf(screen.getByRole('menu'))
    expect(layer.style.left).toBe(`${baseAnchor.left}px`)
    expect(layer.style.top).toBe(`${baseAnchor.bottom + 4}px`)
    expect(layer.style.transform).toBe('')
  })

  it('stays at its natural width by default', () => {
    render(<Harness />)
    expect(layerOf(screen.getByRole('menu')).style.minWidth).toBe('')
  })

  it('matchWidth stretches the layer to the trigger box', () => {
    render(<Harness matchWidth />)
    const layer = layerOf(screen.getByRole('menu'))
    expect(layer.style.minWidth).toBe(`${baseAnchor.right - baseAnchor.left}px`)
    expect(layer.style.width).toBe(`${baseAnchor.right - baseAnchor.left}px`)
  })

  it('content-sized layers keep an intrinsic width inside the viewport', () => {
    render(<Harness />)
    const layer = layerOf(screen.getByRole('menu'))
    // shrink-to-fit would read the space left of the layer's own placement,
    // which placeMenu derives from the measured width: a wide row would grow
    // its space back every frame
    expect(layer.style.width).toBe('max-content')
    expect(layer.style.maxWidth).toBe(`${window.innerWidth - 16}px`)
  })

  // placement math lives in placeMenu's own describe below, the component
  // cases here cover wiring only

  it('stays open for presses inside the menu', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('menuitem'))
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('closes on an outside press', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes on escape', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('ignores modified escapes', () => {
    // chords like Ctrl+Escape (the Windows Start menu) belong to the platform
    render(<Harness />)
    fireEvent.keyDown(document.body, { key: 'Escape', ctrlKey: true })
    fireEvent.keyDown(document.body, { key: 'Escape', metaKey: true })
    fireEvent.keyDown(document.body, { key: 'Escape', altKey: true })
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('stands down for escape during composition', () => {
    // Escape cancels an in-flight IME composition, never closes the layer
    render(<Harness />)
    fireEvent.keyDown(document.body, { key: 'Escape', isComposing: true })
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('answers escape only on the topmost popover', async () => {
    // two pane menus can stack, one press unwinds exactly one layer, topmost
    const user = userEvent.setup()
    render(
      <>
        <Harness label="outer" />
        <Harness label="inner" />
      </>,
    )

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu', { name: 'inner' })).not.toBeInTheDocument()
    expect(screen.getByRole('menu', { name: 'outer' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('leaves an escape claimed elsewhere alone', () => {
    // e.g. the composer hiding its @-menu claims the press first, and this
    // listener registers before render so it answers before the popover's own
    const claim = (ev: KeyboardEvent) => ev.preventDefault()
    document.addEventListener('keydown', claim, { once: true })
    render(<Harness />)

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('restores trigger focus on escape close', async () => {
    const user = userEvent.setup()
    render(<Harness startOpen={false} />)

    await user.click(screen.getByRole('button', { name: 'trigger' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'trigger' })).toHaveFocus()
  })

  it('restores trigger focus on outside press', async () => {
    const user = userEvent.setup()
    render(<Harness startOpen={false} />)

    await user.click(screen.getByRole('button', { name: 'trigger' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    // a bare pointerdown, not user.click: in a browser a real click moves
    // focus to the pressed element, fighting the restore this asserts
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'trigger' })).toHaveFocus()
  })

  it('restoreFocus false leaves focus wherever closing left it', async () => {
    const user = userEvent.setup()
    render(<Harness startOpen={false} restoreFocus={false} />)

    await user.click(screen.getByRole('button', { name: 'trigger' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    // the caret moved on since opening, a blur-closed layer's position
    const aside = document.createElement('button')
    aside.tabIndex = 0
    document.body.appendChild(aside)
    aside.focus()
    expect(aside).toHaveFocus()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    // the close never dragged focus back to the trigger
    expect(aside).toHaveFocus()

    // scratch tabs must not leak into later keyboard walks' tab order
    aside.remove()
  })

  it('repositions when the window scrolls while open', () => {
    render(<Harness />)
    expect(layerOf(screen.getByRole('menu')).style.top).toBe(`${baseAnchor.bottom + 4}px`)

    anchorBox = { ...baseAnchor, top: 700, bottom: 724 }
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    // the trigger now sits near the bottom edge, so the menu flips above
    expect(layerOf(screen.getByRole('menu')).style.top).toBe(
      `${anchorBox.top - 4 - menuSize.height}px`,
    )
  })

  it('repositions when the window resizes while open', () => {
    // no visual viewport stub here: this is the layout-viewport fallback path
    render(<Harness />)
    expect(layerOf(screen.getByRole('menu')).style.top).toBe(`${baseAnchor.bottom + 4}px`)

    act(() => {
      // a viewport too short for below flips the menu above
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 180 })
    })
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(layerOf(screen.getByRole('menu')).style.top).toBe(
      `${baseAnchor.top - 4 - menuSize.height}px`,
    )
  })

  it('repositions when the visual viewport resizes while open', () => {
    // a keyboard shrinking the visible area flips the menu without the layout
    // viewport ever moving
    stubViewport()
    render(<Harness />)
    expect(layerOf(screen.getByRole('menu')).style.top).toBe(`${baseAnchor.bottom + 4}px`)

    vv.height = 180
    act(() => {
      vv.dispatchEvent(new Event('resize'))
    })
    // too short below now, room left above, so the menu flips over the trigger
    expect(layerOf(screen.getByRole('menu')).style.top).toBe(
      `${baseAnchor.top - 4 - menuSize.height}px`,
    )
  })

  it('clamps into an offset visual viewport', () => {
    // floating browser chrome shrinking the visible window from the left:
    // fixed coordinates stay layout-relative, so only the usable box moves
    stubViewport({ width: 300, offsetLeft: 40 })
    render(<Harness />)
    // the 200px menu hugs the usable right edge, 8px inside its 340px bound
    expect(layerOf(screen.getByRole('menu')).style.left).toBe(`${40 + 300 - 8 - menuSize.width}px`)
  })

  it('caps its height inside a keyboard-shortened viewport', () => {
    stubViewport({ height: 300 })
    menuSize = { width: 200, height: 400 }
    render(<Harness />)

    const layer = layerOf(screen.getByRole('menu'))
    // neither side fits the 284px cap, so the menu pins at the top margin and
    // scrolls inside the usable box instead of spilling under the keyboard
    expect(layer.style.top).toBe('8px')
    expect(layer.style.maxHeight).toBe('284px')
    expect(layer.style.overflowY).toBe('auto')
  })

  it('leaves its height uncapped while the usable viewport fits it', () => {
    stubViewport()
    render(<Harness />)

    const layer = layerOf(screen.getByRole('menu'))
    expect(layer.style.maxHeight).toBe('')
    expect(layer.style.overflowY).toBe('')
  })

  it('follows a trigger that moves without resizing', () => {
    render(<Harness />)
    expect(layerOf(screen.getByRole('menu')).style.left).toBe(`${baseAnchor.left}px`)

    // a pane divider drag shifts the whole trigger box, no scroll or resize
    anchorBox = { ...baseAnchor, left: 200, right: 260 }
    flushFrame()
    expect(layerOf(screen.getByRole('menu')).style.left).toBe(`${anchorBox.left}px`)
  })

  it('follows a trigger that resizes while open', () => {
    render(<Harness matchWidth />)
    expect(layerOf(screen.getByRole('menu')).style.minWidth).toBe(
      `${baseAnchor.right - baseAnchor.left}px`,
    )

    // header chips wrap: the trigger box narrows with its pane
    anchorBox = { ...baseAnchor, left: 320, right: 350 }
    flushFrame()
    expect(layerOf(screen.getByRole('menu')).style.left).toBe(`${anchorBox.left}px`)
    expect(layerOf(screen.getByRole('menu')).style.minWidth).toBe(
      `${anchorBox.right - anchorBox.left}px`,
    )
  })

  it('toggles from its own trigger without a close-reopen race', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('trigger'))
    // the press lands on the anchor, which toggles, no outside-close fights it
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

// ItemsHost mounts a closed role=menu layer over its trigger, with named
// items, an optional marked-current label, native-disabled item and header
// filter row -- the shapes the shared key behavior must tell apart. Radio and
// checkbox items carry aria-checked, plain items aria-current.
type ItemRole = 'menuitem' | 'menuitemradio' | 'menuitemcheckbox'

function ItemsHost({
  labels,
  current,
  disabled,
  filter,
  role = 'menuitem',
}: {
  labels: string[]
  current?: string
  disabled?: string
  filter?: boolean
  role?: ItemRole
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="popover-anchor"
        onClick={() => setOpen((v) => !v)}
      >
        trigger
      </button>
      {open && (
        <MenuPopover
          anchorRef={anchorRef}
          role="menu"
          aria-label="items menu"
          className="popover-menu"
          header={
            filter && (
              <div className="menu-filter-row">
                <input type="search" autoFocus aria-label="Filter models" />
              </div>
            )
          }
          onClose={() => setOpen(false)}
        >
          {labels.map((label) => (
            <button
              key={label}
              type="button"
              role={role}
              disabled={label === disabled || undefined}
              aria-checked={role === 'menuitem' ? undefined : label === current}
              aria-current={role === 'menuitem' && label === current ? 'true' : undefined}
              onClick={() => setOpen(false)}
            >
              {label}
            </button>
          ))}
        </MenuPopover>
      )}
    </>
  )
}

// openWithKeyboard presses the trigger like a keyboard user would: one tab to
// reach it, Enter to open -- the key press that lets MenuPopover tell
// keyboard opens from pointer taps.
async function openWithKeyboard(user: ReturnType<typeof userEvent.setup>) {
  await user.tab()
  await user.keyboard('{Enter}')
  return await screen.findByRole('menu', { name: 'items menu' })
}

describe('MenuPopover menu keys', () => {
  it('keyboard opening focuses the first item', async () => {
    const user = userEvent.setup()
    render(<ItemsHost labels={['first', 'second']} />)
    await openWithKeyboard(user)

    expect(screen.getByRole('menuitem', { name: 'first' })).toHaveFocus()
  })

  it('keyboard opening prefers the current item', async () => {
    const user = userEvent.setup()
    render(<ItemsHost labels={['plain', 'marked']} current="marked" />)
    await openWithKeyboard(user)

    expect(screen.getByRole('menuitem', { name: 'marked' })).toHaveFocus()
  })

  it('keyboard opening lands on the checked radio', async () => {
    // a single-select list marks its current item with aria-checked, not
    // aria-current, and the keyboard open must still find it
    const user = userEvent.setup()
    render(<ItemsHost labels={['plain', 'picked']} current="picked" role="menuitemradio" />)
    await openWithKeyboard(user)

    expect(screen.getByRole('menuitemradio', { name: 'picked' })).toHaveFocus()
    expect(screen.getByRole('menuitemradio', { name: 'picked' })).toBeChecked()
    expect(screen.getByRole('menuitemradio', { name: 'plain' })).not.toBeChecked()
  })

  it('keyboard opening skips a disabled first item', async () => {
    const user = userEvent.setup()
    render(<ItemsHost labels={['out', 'next']} disabled="out" />)
    await openWithKeyboard(user)

    expect(screen.getByRole('menuitem', { name: 'next' })).toHaveFocus()
  })

  it('content autofocus keeps the caret over item focus', async () => {
    // the model menu's filter: its own mount focus wins, items never steal
    const user = userEvent.setup()
    render(<ItemsHost labels={['first']} filter />)
    await openWithKeyboard(user)

    expect(screen.getByRole('menuitem', { name: 'first' })).not.toHaveFocus()
    expect(screen.getByLabelText('Filter models')).toHaveFocus()
  })

  it('pointer opening leaves focus on the trigger', async () => {
    const user = userEvent.setup()
    render(<ItemsHost labels={['first']} />)
    await user.click(screen.getByRole('button', { name: 'trigger' }))
    expect(await screen.findByRole('menu', { name: 'items menu' })).toBeInTheDocument()

    expect(screen.getByRole('menuitem', { name: 'first' })).not.toHaveFocus()
    expect(screen.getByRole('button', { name: 'trigger' })).toHaveFocus()
  })

  it('arrows walk enabled items with wrap-around', async () => {
    const user = userEvent.setup()
    render(<ItemsHost labels={['a', 'skipped', 'c']} disabled="skipped" />)
    const menu = await openWithKeyboard(user)
    expect(within(menu).getByRole('menuitem', { name: 'a' })).toHaveFocus()

    // down from the top lands past the disabled entry, and wrapping carries
    // past both ends without ever escaping the menu
    await user.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: 'c' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: 'a' })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(within(menu).getByRole('menuitem', { name: 'c' })).toHaveFocus()
  })

  it('arrows walk radio items too', async () => {
    // the model and permission menus are single-select lists, their rows are
    // menuitemradio and must ride the same navigation as plain items
    const user = userEvent.setup()
    render(
      <ItemsHost
        labels={['a', 'skipped', 'c']}
        current="a"
        disabled="skipped"
        role="menuitemradio"
      />,
    )
    const menu = await openWithKeyboard(user)
    expect(within(menu).getByRole('menuitemradio', { name: 'a' })).toHaveFocus()

    await user.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitemradio', { name: 'c' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(within(menu).getByRole('menuitemradio', { name: 'c' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(within(menu).getByRole('menuitemradio', { name: 'a' })).toHaveFocus()
  })

  it('arrows walk checkbox items too', async () => {
    const user = userEvent.setup()
    render(<ItemsHost labels={['x', 'y']} role="menuitemcheckbox" />)
    const menu = await openWithKeyboard(user)
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'x' })).toHaveFocus()

    await user.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'y' })).toHaveFocus()
  })

  it('home and end jump to the enabled ends', async () => {
    const user = userEvent.setup()
    render(<ItemsHost labels={['a', 'skipped', 'c']} disabled="skipped" />)
    const menu = await openWithKeyboard(user)

    await user.keyboard('{End}')
    expect(within(menu).getByRole('menuitem', { name: 'c' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(within(menu).getByRole('menuitem', { name: 'a' })).toHaveFocus()
  })

  it('arrows answer the trigger on a pointer-open menu', async () => {
    const user = userEvent.setup()
    render(<ItemsHost labels={['first']} />)
    await user.click(screen.getByRole('button', { name: 'trigger' }))
    await screen.findByRole('menu', { name: 'items menu' })

    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'first' })).toHaveFocus()
  })

  it('leaves a caret in the filter alone', async () => {
    const user = userEvent.setup()
    render(<ItemsHost labels={['first']} filter />)
    await openWithKeyboard(user)

    await user.keyboard('{ArrowDown}')
    expect(screen.getByLabelText('Filter models')).toHaveFocus()
  })

  it('renders the header inside the layer but outside the menu', async () => {
    const user = userEvent.setup()
    render(<ItemsHost labels={['first']} filter />)
    const menu = await openWithKeyboard(user)

    // the filter row rides the layer above the role element: the menu's
    // children are items only, the input never reads as one
    const filter = screen.getByLabelText('Filter models')
    expect(menu).not.toContainElement(filter)
    expect(filter.closest('[role="menu"]')).toBeNull()
    expect(layerOf(menu)).toContainElement(filter)
    expect(menu.querySelector('input')).toBeNull()
    // tab order still runs filter first, then the items
    expect(
      filter.compareDocumentPosition(screen.getByRole('menuitem', { name: 'first' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('measures the whole layer, header included', () => {
    // the header belongs to the measured box: a layer measured at its role
    // element alone would flip against the wrong height
    render(<Harness header={<div className="popover-header">filter</div>} />)
    const menu = screen.getByRole('menu')
    expect(layerOf(menu)).toContainElement(screen.getByText('filter'))
    expect(menu).not.toContainElement(screen.getByText('filter'))

    anchorBox = { ...baseAnchor, top: 700, bottom: 724 }
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    // the 64px stubbed height is the layer's (.popover-menu), not the role box
    expect(layerOf(menu).style.top).toBe(`${anchorBox.top - 4 - menuSize.height}px`)
  })

  it('enter activates the focused item', async () => {
    const user = userEvent.setup()
    render(<ItemsHost labels={['first']} />)
    await openWithKeyboard(user)

    await user.keyboard('{Enter}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('space activates the focused item', async () => {
    const user = userEvent.setup()
    render(<ItemsHost labels={['first']} />)
    await openWithKeyboard(user)

    await user.keyboard(' ')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('tab closes and restores the trigger', async () => {
    const user = userEvent.setup()
    render(<ItemsHost labels={['first']} />)
    await openWithKeyboard(user)

    // no preventDefault: closing hands focus back to the trigger, then the
    // browser's own walk continues from there
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'first' }), { key: 'Tab' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'trigger' })).toHaveFocus()
  })

  it('tab closes a pointer-open menu too', async () => {
    const user = userEvent.setup()
    render(<ItemsHost labels={['first']} />)
    await user.click(screen.getByRole('button', { name: 'trigger' }))
    await screen.findByRole('menu', { name: 'items menu' })

    // the layer never outlives the focus walk: closing restores the trigger
    // it opened from, then the walk continues from there
    fireEvent.keyDown(document.body, { key: 'Tab' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'trigger' })).toHaveFocus()
  })
})

describe('placeMenu', () => {
  const anchor = { top: 100, bottom: 124, left: 300, right: 360 }
  const size = { width: 200, height: 64 }
  const viewport = { top: 0, left: 0, right: 1024, bottom: 768 }

  it('hangs below when the space fits', () => {
    expect(placeMenu(anchor, size, viewport, 'left')).toEqual({ left: 300, top: 128 })
  })

  it('flips above a bottom edge overflow', () => {
    const low = { ...anchor, top: 700, bottom: 724 }
    expect(placeMenu(low, size, viewport, 'left')).toEqual({ left: 300, top: 632 })
  })

  it('clamps horizontally into the viewport', () => {
    const offscreen = { ...anchor, left: -40, right: 20 }
    expect(placeMenu(offscreen, size, viewport, 'left')).toEqual({ left: 8, top: 128 })
  })

  it('right-aligns without clamping while it fits', () => {
    const wide = { ...anchor, left: 950, right: 1010 }
    expect(placeMenu(wide, size, viewport, 'right')).toEqual({ left: 810, top: 128 })
  })

  it('right-aligns and clamps a near-left trigger into view', () => {
    const tight = { ...anchor, left: 30, right: 90 }
    expect(placeMenu(tight, size, viewport, 'right')).toEqual({ left: 8, top: 128 })
  })

  it('pins to the roomier side when neither fits', () => {
    // a 64px menu against a 100px viewport: below offers 16, above 56
    const tiny = { top: 0, left: 0, right: 1024, bottom: 100 }
    expect(placeMenu({ ...anchor, top: 60, bottom: 80 }, size, tiny, 'left')).toEqual({
      left: 300,
      top: 8,
    })
    expect(placeMenu({ ...anchor, top: 20, bottom: 40 }, size, tiny, 'left')).toEqual({
      left: 300,
      top: 28,
    })
  })

  it('keeps a taller-than-viewport menu inside the top edge', () => {
    const tall = { width: 200, height: 120 }
    // below is roomier but cannot fit either, pin at the margin, not off-screen
    expect(
      placeMenu(
        { ...anchor, top: 10, bottom: 30 },
        tall,
        { top: 0, left: 0, right: 1024, bottom: 100 },
        'left',
      ),
    ).toEqual({ left: 300, top: 8, maxHeight: 84 })
  })

  it('anchors at the trigger when the menu outgrows the viewport', () => {
    const huge = { width: 2000, height: 64 }
    expect(placeMenu(anchor, huge, viewport, 'left')).toEqual({ left: 300, top: 128 })
  })

  it('clamps into a panned usable box without moving the anchor', () => {
    // a 40px chrome strip on the left: the box the menu must fit shifts, the
    // trigger's fixed coordinates do not
    const shifted = { top: 0, left: 40, right: 340, bottom: 768 }
    expect(placeMenu(anchor, size, shifted, 'left')).toEqual({ left: 132, top: 128 })
  })

  it('caps its height against the usable box and reports the cap', () => {
    const keyboard = { top: 0, left: 0, right: 1024, bottom: 300 }
    expect(
      placeMenu({ ...anchor, top: 10, bottom: 30 }, { width: 200, height: 400 }, keyboard, 'left'),
    ).toEqual({ left: 300, top: 8, maxHeight: 284 })
  })

  it('keeps the capped menu inside the usable box', () => {
    // the raw 400px menu pinned above a 128px-tall strip would spill 280px
    // behind the keyboard; its 112px cap fits whole
    const strip = { top: 0, left: 0, right: 1024, bottom: 128 }
    expect(placeMenu(anchor, { width: 200, height: 400 }, strip, 'left')).toEqual({
      left: 300,
      top: 8,
      maxHeight: 112,
    })
  })
})

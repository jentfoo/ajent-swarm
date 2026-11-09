import { useRef, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MenuPopover, placeMenu } from './MenuPopover'

// The popover portals past overflow clipping into document.body, flips or
// clamps to stay in the viewport, and closes on Escape or an outside press:
// only the topmost of stacked popovers answers Escape, a press another
// listener claimed is left alone, and closing returns focus to the element
// focused before opening. jsdom has no layout: geometry is stubbed by class.

const baseAnchor = { top: 100, bottom: 124, left: 300, right: 360 }
const menuSize = { width: 200, height: 64 }

let anchorBox = baseAnchor

function rectFor(el: Element): Record<string, number> {
  if (el.classList.contains('popover-anchor')) return anchorBox
  if (el.classList.contains('popover-menu'))
    return { top: 0, bottom: menuSize.height, left: 0, right: menuSize.width }
  return { top: 0, bottom: 0, left: 0, right: 0 }
}

beforeEach(() => {
  anchorBox = baseAnchor
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
})

// the resize case pins innerHeight, restore the jsdom default between tests
const innerHeightDesc = Object.getOwnPropertyDescriptor(window, 'innerHeight')!

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(window, 'innerHeight', innerHeightDesc)
})

// Harness keeps the popover open beside a trigger under an overflow-clipped
// ancestor, the pane condition MenuPopover exists to escape. startOpen=false
// exercises the click-to-open flow so the trigger holds focus while opening
// label names trigger and menu together so stacked instances stay distinct.
function Harness({
  align = 'left',
  startOpen = true,
  label = 'trigger',
}: {
  align?: 'left' | 'right'
  startOpen?: boolean
  label?: string
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
          role="menu"
          aria-label={label}
          className="menu popover-menu"
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

describe('MenuPopover', () => {
  it('portals past a clipped ancestor into the body', () => {
    render(<Harness />)
    const menu = screen.getByRole('menu')
    expect(menu.parentElement).toBe(document.body)
    expect(menu.closest('.clip')).toBeNull()
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

  it('repositions when the window scrolls while open', () => {
    render(<Harness />)
    expect(screen.getByRole('menu').style.top).toBe(`${baseAnchor.bottom + 4}px`)

    anchorBox = { ...baseAnchor, top: 700, bottom: 724 }
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    // the trigger now sits near the bottom edge, so the menu flips above
    expect(screen.getByRole('menu').style.top).toBe(`${anchorBox.top - 4 - menuSize.height}px`)
  })

  it('repositions when the window resizes while open', () => {
    render(<Harness />)
    expect(screen.getByRole('menu').style.top).toBe(`${baseAnchor.bottom + 4}px`)

    act(() => {
      // a viewport too short for below flips the menu above
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 180 })
    })
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(screen.getByRole('menu').style.top).toBe(`${baseAnchor.top - 4 - menuSize.height}px`)
  })

  it('toggles from its own trigger without a close-reopen race', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('trigger'))
    // the press lands on the anchor, which toggles, no outside-close fights it
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

describe('placeMenu', () => {
  const anchor = { top: 100, bottom: 124, left: 300, right: 360 }
  const size = { width: 200, height: 64 }
  const viewport = { width: 1024, height: 768 }

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
    const tiny = { width: 1024, height: 100 }
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
      placeMenu({ ...anchor, top: 10, bottom: 30 }, tall, { width: 1024, height: 100 }, 'left'),
    ).toEqual({ left: 300, top: 8 })
  })

  it('anchors at the trigger when the menu outgrows the viewport', () => {
    const huge = { width: 2000, height: 64 }
    expect(placeMenu(anchor, huge, viewport, 'left')).toEqual({ left: 300, top: 128 })
  })
})

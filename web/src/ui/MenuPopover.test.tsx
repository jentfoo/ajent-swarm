import { useRef, useState } from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MenuPopover, placeMenu } from './MenuPopover'

// The popover portals past overflow clipping into document.body, flips or
// clamps to stay in the viewport, and closes on Escape or an outside press.
// jsdom has no layout: trigger and menu geometry is stubbed by class.

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

afterEach(() => {
  vi.restoreAllMocks()
})

// Harness keeps the popover open beside a trigger under an overflow-clipped
// ancestor, the pane condition MenuPopover exists to escape.
function Harness({ align = 'left' }: { align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(true)
  const anchorRef = useRef<HTMLButtonElement>(null)
  return (
    <div className="clip" style={{ overflow: 'hidden', padding: 8 }}>
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
          align={align}
          role="menu"
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

  it('hangs below the trigger by default', () => {
    render(<Harness />)
    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe('300px')
    expect(menu.style.top).toBe(`${baseAnchor.bottom + 4}px`) // bottom plus the anchor gap
  })

  it('flips above a bottom edge overflow', () => {
    anchorBox = { ...baseAnchor, top: 700, bottom: 724 }
    render(<Harness />)
    const menu = screen.getByRole('menu')
    // below offers 40px against the menu's 64; above offers 696
    expect(menu.style.top).toBe(`${anchorBox.top - 4 - menuSize.height}px`)
    expect(menu.style.left).toBe('300px')
  })

  it('clamps a left-edge trigger into view', () => {
    anchorBox = { ...baseAnchor, left: -40, right: 20 }
    render(<Harness />)
    const menu = screen.getByRole('menu')
    expect(menu.style.left).toBe('8px') // the edge margin
    expect(menu.style.top).toBe(`${baseAnchor.bottom + 4}px`) // still below
  })

  it('right-aligns when asked', () => {
    render(<Harness align="right" />)
    const menu = screen.getByRole('menu')
    // hangs left from the trigger's right edge: 360 - 200
    expect(menu.style.left).toBe(`${baseAnchor.right - menuSize.width}px`)
  })

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
    // the press lands on the anchor, which toggles; no outside-close fights it
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
    // below is roomier but cannot fit either; pin at the margin, not off-screen
    expect(
      placeMenu({ ...anchor, top: 10, bottom: 30 }, tall, { width: 1024, height: 100 }, 'left'),
    ).toEqual({ left: 300, top: 8 })
  })

  it('anchors at the trigger when the menu outgrows the viewport', () => {
    const huge = { width: 2000, height: 64 }
    expect(placeMenu(anchor, huge, viewport, 'left')).toEqual({ left: 300, top: 128 })
  })
})

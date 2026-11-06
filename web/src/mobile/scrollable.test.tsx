import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'

import { horizontallyScrollable, scrollableUnder } from './scrollable'

// Ancestor resolution for touch gestures: the nearest scroller on an axis
// wins, the document root stands in when none exists, and only real sideways
// overflow counts as horizontally scrollable, which is what keeps a code
// fence drag from opening the switcher while vertical scrollers stay quiet.

function Tree(): ReactElement {
  return (
    <div data-testid="vertical" style={{ overflowY: 'auto' }}>
      <span data-testid="plain">text</span>
    </div>
  )
}

// wideAs overrides an element's box so jsdom, which has no layout, reports
// sideways overflow the way a real code fence lays out.
function wideAs(el: HTMLElement, scroll: number, client: number): void {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scroll })
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: client })
}

describe('scrollable', () => {
  it('resolves the nearest vertical scroller above the touch', () => {
    render(<Tree />)
    expect(scrollableUnder(screen.getByTestId('plain'), 'y')).toBe(screen.getByTestId('vertical'))
  })

  it('stands in the document root with no inner scroller', () => {
    render(<Tree />)
    expect(scrollableUnder(screen.getByTestId('vertical'), 'x')).toBe(document.documentElement)
  })

  it('marks a sideways scroller with real overflow', () => {
    render(
      <div data-testid="fence" style={{ overflowX: 'auto' }}>
        <span data-testid="line">long line</span>
      </div>,
    )
    wideAs(screen.getByTestId('fence'), 600, 320)
    expect(horizontallyScrollable(screen.getByTestId('line'))).toBe(true)
  })

  it('keeps a vertical scroller without sideways overflow quiet', () => {
    render(<Tree />)
    const scroller = screen.getByTestId('vertical')
    wideAs(scroller, 320, 320)
    expect(horizontallyScrollable(screen.getByTestId('plain'))).toBe(false)
  })

  it('ignores touches that carry no element target', () => {
    expect(horizontallyScrollable(null)).toBe(false)
    expect(horizontallyScrollable(window)).toBe(false)
  })
})

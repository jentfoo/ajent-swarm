import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'

import { scrollableUnder } from './scrollable'

// Ancestor resolution for touch gestures: the nearest real vertical scroller
// wins, styled wrappers whose content fits never count, and the document root
// stands in when none exists.

function Tree(): ReactElement {
  return (
    <div data-testid="vertical" style={{ overflowY: 'auto' }}>
      <span data-testid="plain">text</span>
    </div>
  )
}

// tallAs gives an element vertical overflow jsdom cannot compute, standing in
// for a page scroller with content above the touch.
function tallAs(el: HTMLElement, scroll: number, client: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scroll })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: client })
}

describe('scrollable', () => {
  it('resolves the nearest vertical scroller above the touch', () => {
    render(<Tree />)
    tallAs(screen.getByTestId('vertical'), 800, 200)
    expect(scrollableUnder(screen.getByTestId('plain'))).toBe(screen.getByTestId('vertical'))
  })

  it('skips a styled wrapper that cannot scroll', () => {
    render(
      <div data-testid="page" style={{ overflowY: 'auto' }}>
        <div data-testid="dead" style={{ overflowY: 'auto' }}>
          <span data-testid="row">text</span>
        </div>
      </div>,
    )
    tallAs(screen.getByTestId('page'), 800, 200)
    expect(scrollableUnder(screen.getByTestId('row'))).toBe(screen.getByTestId('page'))
  })

  it('stands in the document root with no inner scroller', () => {
    render(<span data-testid="bare">text</span>)
    expect(scrollableUnder(screen.getByTestId('bare'))).toBe(document.documentElement)
  })
})

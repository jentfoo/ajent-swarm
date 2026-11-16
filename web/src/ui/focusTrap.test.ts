import { afterEach, describe, expect, it } from 'vitest'

import { cycleFocus } from './focusTrap'

// One Tab press inside a panel: entry through whichever end the direction
// reaches first, wrap at both ends, and a hold on the panel when nothing
// inside is focusable.

function mountPanel(controls: string): { panel: HTMLElement; items: HTMLElement[] } {
  const panel = document.createElement('div')
  panel.innerHTML = controls
  document.body.append(panel)
  return { panel, items: Array.from(panel.querySelectorAll<HTMLElement>('button')) }
}

function tabPress(shift = false): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, cancelable: true })
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('cycleFocus', () => {
  it('enters through the first control from the panel', () => {
    const { panel, items } = mountPanel('<button>a</button><button>b</button>')

    cycleFocus(panel, tabPress())
    expect(document.activeElement).toBe(items[0])
  })

  it('steps forward and wraps at both ends', () => {
    const { panel, items } = mountPanel('<button>a</button><button>b</button>')
    items[0].focus()

    cycleFocus(panel, tabPress())
    expect(document.activeElement).toBe(items[1])

    // the last control wraps back to the first
    cycleFocus(panel, tabPress())
    expect(document.activeElement).toBe(items[0])
  })

  it('steps back with shift and wraps to the end', () => {
    const { panel, items } = mountPanel('<button>a</button><button>b</button>')
    items[1].focus()

    cycleFocus(panel, tabPress(true))
    expect(document.activeElement).toBe(items[0])

    // the first control wraps back to the last
    cycleFocus(panel, tabPress(true))
    expect(document.activeElement).toBe(items[1])
  })

  it('enters through the end the direction reaches first', () => {
    const { panel, items } = mountPanel('<button>a</button><button>b</button>')
    document.body.focus()

    cycleFocus(panel, tabPress(true))
    expect(document.activeElement).toBe(items[1])
  })

  it('skips controls the selector excludes', () => {
    const markup =
      '<button disabled>dead</button><span tabindex="-1">flat</span>' +
      '<input type="hidden"><a href="#">link</a>'
    const { panel } = mountPanel(markup)

    cycleFocus(panel, tabPress())
    expect(document.activeElement).toBe(panel.querySelector('a[href]'))
  })

  it('holds on a panel with nothing focusable', () => {
    const { panel } = mountPanel('<p>rows</p>')
    document.body.focus()

    const press = tabPress()
    cycleFocus(panel, press)
    expect(press.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(document.body)
  })
})

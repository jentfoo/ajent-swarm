import { vi } from 'vitest'

// jsdom has no layout, so document.elementFromPoint does not exist there.
// pointAt installs one answering a fixed element (or null), for drag gestures
// that resolve the row under a held pointer. `set` swaps the answer mid-test,
// `restore` undoes the install.
export function pointAt(under: Element | null) {
  const holder = document as { elementFromPoint?: typeof document.elementFromPoint }
  const original = holder.elementFromPoint
  const spy = vi.fn(() => under)
  holder.elementFromPoint = spy
  return {
    set(next: Element | null) {
      spy.mockImplementation(() => next)
    },
    restore() {
      if (original === undefined) delete holder.elementFromPoint
      else holder.elementFromPoint = original
    },
  }
}

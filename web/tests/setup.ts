import '@testing-library/jest-dom/vitest'

// jsdom ships neither observer; the transcript's autoscroll and shiki's
// container queries would throw on mount without a stand-in.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}

// Layout geometry for the virtualized transcript: jsdom reports every box at
// zero, which would render an empty window. A fixed viewport with uniform row
// heights keeps the window math deterministic; tests scroll by setting
// scrollTop and dispatching a scroll event.
if (typeof window !== 'undefined') {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return 1200
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return 72
    },
  })
  // jsdom ships no implementation; the queue cursor only keeps rows in view.
  Element.prototype.scrollIntoView = () => {}

  // jsdom reports every box at zero; a fixed in-viewport rect keeps geometry
  // checks (armed confirms, popover anchoring) deterministic. Tests that care
  // about placement spy per element.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return new DOMRect(0, 0, 1200, 72)
  }

  // jsdom ships no matchMedia either; components must not special-case that.
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

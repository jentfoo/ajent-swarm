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
}

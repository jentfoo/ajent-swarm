// scrollableUnder resolves what a touch would scroll on one axis: the nearest
// element at or above the touched node that really scrolls that way. Mobile
// pages scroll inside the shell's content element, never the window, the
// document root stands in when no inner scroller exists.
export function scrollableUnder(target: Element, axis: 'x' | 'y'): HTMLElement {
  let node: Element | null = target
  while (node !== null) {
    if (node instanceof HTMLElement && canScroll(node, axis)) return node
    node = node.parentElement
  }
  return document.documentElement
}

// horizontallyScrollable reports whether a touch on target begins inside an
// element that can scroll sideways right now, which keeps a code fence drag
// from opening the switcher while vertical scrollers stay quiet.
export function horizontallyScrollable(target: EventTarget | null): boolean {
  return target instanceof Element && scrollableUnder(target, 'x') !== document.documentElement
}

// canScroll demands real overflow, not just the style: a vertical scroller
// computes overflow-x auto beside its own overflow-y, and an auto-height
// wrapper styled overflow-y auto never scrolls at all, so neither may shadow
// the scroller actually under the touch.
function canScroll(node: HTMLElement, axis: 'x' | 'y'): boolean {
  const style = getComputedStyle(node)
  const overflow = axis === 'x' ? style.overflowX : style.overflowY
  if (overflow !== 'auto' && overflow !== 'scroll') return false
  return axis === 'x' ? node.scrollWidth > node.clientWidth : node.scrollHeight > node.clientHeight
}

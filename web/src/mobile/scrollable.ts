// scrollableUnder resolves what a touch would scroll on one axis: the nearest
// element at or above the touched node with overflow in that direction.
// Mobile pages scroll inside the shell's content element, never the window;
// the document root stands in when no inner scroller exists.
export function scrollableUnder(target: Element, axis: 'x' | 'y'): HTMLElement {
  let node: Element | null = target
  while (node !== null) {
    if (node instanceof HTMLElement) {
      const style = getComputedStyle(node)
      const overflow = axis === 'x' ? style.overflowX : style.overflowY
      if (overflow === 'auto' || overflow === 'scroll') return node
    }
    node = node.parentElement
  }
  return document.documentElement
}

// horizontallyScrollable reports whether a touch on target begins inside an
// element that can scroll sideways right now. The overflow test alone is not
// enough: a vertical scroller computes overflow-x to auto beside its own
// overflow-y, so only real sideways overflow (content past the client box)
// counts, which is the code fences in transcripts.
export function horizontallyScrollable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  let node: Element | null = target
  while (node !== null) {
    if (node instanceof HTMLElement) {
      const overflowX = getComputedStyle(node).overflowX
      if ((overflowX === 'auto' || overflowX === 'scroll') && node.scrollWidth > node.clientWidth) {
        return true
      }
    }
    node = node.parentElement
  }
  return false
}

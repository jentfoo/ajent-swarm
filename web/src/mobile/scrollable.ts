// scrollableUnder resolves what a touch would scroll vertically: the nearest
// element at or above the touched node that really scrolls. Mobile pages
// scroll inside the shell's content element, never the window, the
// document root stands in when no inner scroller exists.
export function scrollableUnder(target: Element): HTMLElement {
  let node: Element | null = target
  while (node !== null) {
    if (node instanceof HTMLElement && canScroll(node)) return node
    node = node.parentElement
  }
  return document.documentElement
}

// canScroll demands real overflow, not just the style: an auto-height
// wrapper styled overflow-y auto never scrolls at all, so it may not shadow
// the scroller actually under the touch.
function canScroll(node: HTMLElement): boolean {
  const style = getComputedStyle(node)
  if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') return false
  return node.scrollHeight > node.clientHeight
}

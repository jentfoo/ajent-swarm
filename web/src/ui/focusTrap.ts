// One selector for what Tab cycles through inside a dialog: the disabled and
// hidden cases the DOM itself can express. Dialog content renders
// conditionally with React, so no layout-based visibility check rides along.
const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([type="hidden"]):not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

// cycleFocus spends one Tab press inside `panel`: focus steps through the
// panel's own controls, wraps at both ends, and holds on the panel when
// nothing inside is focusable.
export function cycleFocus(panel: HTMLElement, ev: KeyboardEvent): void {
  const items = Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector))
  ev.preventDefault()
  if (items.length === 0) return

  // a caret outside the controls, or on the panel itself, enters through
  // whichever end the direction reaches first
  const at = items.indexOf(document.activeElement as HTMLElement)
  const next =
    at < 0
      ? items[ev.shiftKey ? items.length - 1 : 0]
      : items[(at + (ev.shiftKey ? -1 : 1) + items.length) % items.length]
  next.focus()
}

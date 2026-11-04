// First-run flag for the session header's edge-swipe hint: retired by one
// completed swipe or a tap, best effort like every localStorage store.

const storageKey = 'swarm.edgeSwipeHint.v1'

// swipeHintSeen reports whether the hint was already retired. Storage that
// cannot be read counts as seen, so a blocked store never nags.
export function swipeHintSeen(): boolean {
  try {
    return localStorage.getItem(storageKey) !== null
  } catch {
    return true
  }
}

// dismissSwipeHint persists the retirement; a failing write only means the
// hint may return on the next load.
export function dismissSwipeHint(): void {
  try {
    localStorage.setItem(storageKey, '1')
  } catch {
    // best effort
  }
}

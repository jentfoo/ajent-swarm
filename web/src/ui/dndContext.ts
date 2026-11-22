import { useSyncExternalStore } from 'react'

// One module-level drag store for cross-surface session drags: the tile
// workspace and the focus rail publish into it, the composer strip reads it.
// No state library, no DOM globals, no provider: a module singleton survives
// module-boundary quirks and every drag ends through end() so no surface
// holds a stale session id.
let dragging: string | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const notify of listeners) notify()
}

// sessionDrag mutates the store: begin names the dragged session, end clears
// it whatever gesture owned the drag.
export const sessionDrag = {
  begin(sessionId: string) {
    dragging = sessionId
    emit()
  },
  end() {
    dragging = null
    emit()
  },
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify)
  return () => listeners.delete(notify)
}

// resetSessionDrag clears the store, only tests need this for isolation.
export function resetSessionDrag(): void {
  dragging = null
  emit()
}

// useSessionDrag exposes the live drag: dragging names the session being
// dragged, null while idle.
export function useSessionDrag(): { dragging: string | null } {
  const current = useSyncExternalStore(
    subscribe,
    () => dragging,
    () => null,
  )
  return { dragging: current }
}

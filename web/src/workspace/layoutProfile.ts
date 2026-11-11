// The layout profile: which workspace mode the browser is in plus each mode's
// own state, persisted per browser in localStorage. Switching modes preserves
// each one's layout independently, corrupt storage reads as the default.
import { useCallback, useEffect, useRef, useState } from 'react'

import { parseTree } from './tileTree'
import type { TileNode } from './tileTree'

export type WorkspaceMode = 'focused' | 'tile'

interface FocusedLayout {
  selectedSessionId?: string
}

export interface TileLayout {
  tree: TileNode | null
  focusedPaneId?: string
}

export interface LayoutProfile {
  mode: WorkspaceMode
  focused: FocusedLayout
  tile: TileLayout
}

const storageKey = 'swarm.workspace.v1'

// persistence settles this long after the last change, so bursts of commits
// (divider drags, focus following pointerdown) write once instead of per event
export const saveSettleMs = 250

const defaultProfile: LayoutProfile = {
  mode: 'focused',
  focused: {},
  tile: { tree: null },
}

export function loadProfile(): LayoutProfile {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw === null) return { ...defaultProfile }
    const parsed = JSON.parse(raw) as Partial<LayoutProfile>
    const mode: WorkspaceMode = parsed.mode === 'tile' ? 'tile' : 'focused'
    return {
      mode,
      focused: {
        selectedSessionId:
          typeof parsed.focused?.selectedSessionId === 'string'
            ? parsed.focused.selectedSessionId
            : undefined,
      },
      tile: {
        tree: parseTree(parsed.tile?.tree),
        focusedPaneId:
          typeof parsed.tile?.focusedPaneId === 'string' ? parsed.tile.focusedPaneId : undefined,
      },
    }
  } catch {
    return { ...defaultProfile }
  }
}

function saveProfile(profile: LayoutProfile): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(profile))
  } catch {
    // Persisting the layout is best effort.
  }
}

// useLayoutProfile holds the profile in state, so renders follow every change
// immediately, while storage writes settle on a debounce once changes stop.
// Leaving or hiding the page flushes a still-pending save, so a reload never
// loses the arrangement.
export function useLayoutProfile(): {
  profile: LayoutProfile
  setMode: (mode: WorkspaceMode) => void
  selectFocusedSession: (sessionId: string | undefined) => void
  setTileLayout: (tile: TileLayout) => void
} {
  const [profile, setProfile] = useState<LayoutProfile>(loadProfile)
  // mirrors the state for synchronous updates and is the value a pending save
  // writes; a live timer means a save is still pending
  const latestRef = useRef(profile)
  const timerRef = useRef<number | null>(null)

  const flush = useCallback(() => {
    if (timerRef.current === null) return // clean: storage already holds it
    window.clearTimeout(timerRef.current)
    timerRef.current = null
    saveProfile(latestRef.current)
  }, [])

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onHidden)
      flush() // unmounting settles too
    }
  }, [flush])

  const update = useCallback(
    (patch: (prev: LayoutProfile) => LayoutProfile) => {
      const next = patch(latestRef.current)
      latestRef.current = next
      setProfile(next)
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(flush, saveSettleMs)
    },
    [flush],
  )

  const setMode = useCallback(
    (mode: WorkspaceMode) => update((prev) => ({ ...prev, mode })),
    [update],
  )
  const selectFocusedSession = useCallback(
    (sessionId: string | undefined) =>
      update((prev) => ({ ...prev, focused: { ...prev.focused, selectedSessionId: sessionId } })),
    [update],
  )
  const setTileLayout = useCallback(
    (tile: TileLayout) => update((prev) => ({ ...prev, tile })),
    [update],
  )

  return { profile, setMode, selectFocusedSession, setTileLayout }
}

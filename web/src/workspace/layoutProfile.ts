// The layout profile: which workspace mode the browser is in plus each mode's
// own state, persisted per browser in localStorage. Switching modes preserves
// each one's layout independently; corrupt storage reads as the default.
import { useCallback, useState } from 'react'

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

// useLayoutProfile holds the profile in state, writing through on every
// change so reloads restore exactly what the user arranged.
export function useLayoutProfile(): {
  profile: LayoutProfile
  setMode: (mode: WorkspaceMode) => void
  selectFocusedSession: (sessionId: string | undefined) => void
  setTileLayout: (tile: TileLayout) => void
} {
  const [profile, setProfile] = useState<LayoutProfile>(loadProfile)

  const update = useCallback((patch: (prev: LayoutProfile) => LayoutProfile) => {
    setProfile((prev) => {
      const next = patch(prev)
      saveProfile(next)
      return next
    })
  }, [])

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

import { useEffect } from 'react'

import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useWorkspace } from '../providers/workspace'
import FocusedWorkspace from '../workspace/FocusedWorkspace'
import TileWorkspace from '../workspace/TileWorkspace'
import type { WorkspaceMode } from '../workspace/layoutProfile'

// WorkspaceRoute serves the desktop workspaces: / renders the persisted mode,
// /focused and /tile deep-link a mode and persist it for next time.
export default function WorkspaceRoute({ mode }: { mode?: WorkspaceMode }) {
  const { profile, setMode } = useWorkspace()

  useEffect(() => {
    if (mode !== undefined && profile.mode !== mode) setMode(mode)
  }, [mode, profile.mode, setMode])

  const active: WorkspaceMode = mode ?? profile.mode
  useDocumentTitle(active === 'tile' ? 'Tile workspace' : 'Focused workspace')
  return active === 'tile' ? <TileWorkspace /> : <FocusedWorkspace />
}

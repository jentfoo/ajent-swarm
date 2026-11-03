import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { fleet, models as modelsAPI } from '../api/endpoints'
import type { ModelState, SavedSession } from '../api/types'
import { useSwarm } from '../providers/swarm'

export interface LaunchFacts {
  // recorded sessions most recently used first; resume pickers and the
  // workspace suggestions both read this one listing
  saved: SavedSession[]
  // one row per distinct model key across live sessions, sorted by key;
  // grouped selects render these through ui/ModelSelectOptions
  models: ModelState[]
  // workspaces of every seen session, live discovery before the saved
  // listing's recency order, duplicates dropped keeping first sight
  workspaceOptions: string[]
  // refreshSaved re-reads the recorded listing in place; pull-to-refresh uses
  // it so a new recording shows without waiting out a remount
  refreshSaved: () => Promise<void>
}

// useLaunchFacts gathers what the launch surfaces suggest from: known
// workspaces across live and saved sessions, the deduped union of live model
// registries, and the saved rows resume pickers render. Reads are best
// effort; a refused one leaves that section empty instead of blocking a form.
export function useLaunchFacts(): LaunchFacts {
  const { sessions } = useSwarm()
  const [saved, setSaved] = useState<SavedSession[]>([])
  const [models, setModels] = useState<ModelState[]>([])

  // unmount flips the guard so a reply landing after it never touches state
  const savedAliveRef = useRef(true)

  const refreshSaved = useCallback(() => {
    return fleet
      .saved()
      .then((rows) => {
        if (savedAliveRef.current) setSaved(rows)
      })
      .catch(() => {
        // keep the current rows; a refused read retries on the next pull
      })
  }, [])

  useEffect(() => {
    savedAliveRef.current = true
    void refreshSaved()
    return () => {
      savedAliveRef.current = false
    }
  }, [refreshSaved])

  useEffect(() => {
    let alive = true
    modelsAPI
      .options()
      // the server unions every live registry by key; an empty fleet answers null
      .then((rows) => alive && setModels(rows ?? []))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const workspaceOptions = useMemo(
    () => [...new Set([...sessions, ...saved].flatMap((s) => (s.workspace ? [s.workspace] : [])))],
    [sessions, saved],
  )

  return { saved, models, workspaceOptions, refreshSaved }
}

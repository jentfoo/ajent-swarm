import { useEffect, useMemo, useState } from 'react'

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
}

// useLaunchFacts gathers what the launch surfaces suggest from: known
// workspaces across live and saved sessions, one deduped model listing per
// distinct key, and the saved rows resume pickers render. Reads are best
// effort; a refused one leaves that section empty instead of blocking a form.
export function useLaunchFacts(): LaunchFacts {
  const { sessions } = useSwarm()
  const [saved, setSaved] = useState<SavedSession[]>([])
  const [models, setModels] = useState<ModelState[]>([])

  useEffect(() => {
    let alive = true
    fleet
      .saved()
      .then((rows) => alive && setSaved(rows))
      .catch(() => {})
    modelsAPI
      .list()
      .then((rows) => {
        if (!alive) return
        // every live session reports its own registry: keep first row per key
        const byKey = new Map<string, ModelState>()
        for (const r of rows) {
          if (!byKey.has(r.current.key)) byKey.set(r.current.key, r.current)
        }
        setModels([...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const workspaceOptions = useMemo(
    () => [...new Set([...sessions, ...saved].flatMap((s) => (s.workspace ? [s.workspace] : [])))],
    [sessions, saved],
  )

  return { saved, models, workspaceOptions }
}

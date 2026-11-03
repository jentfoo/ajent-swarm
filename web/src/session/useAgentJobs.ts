import { useCallback, useEffect, useState } from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { ActivityRow, AgentJob, Segment } from '../api/types'
import { jobsLive } from './subAgents'

// Re-list cadence while jobs are live: elapsed values and statuses move.
const pollLiveMs = 3_000

// AgentJobs is what the sub-agent surfaces need from the pull listing:
// records keyed by job id (sub-N, the activity row key) plus the guarded
// stop fire. Rows and counts stay the push channels; this only adds the
// per-job status, elapsed and stop affordances.
export interface AgentJobs {
  byId: Map<string, AgentJob>
  // false once upstream answered unavailable (no sub-agent wiring): the job
  // surfaces hide and the badge keeps its prose fallback, never an error.
  available: boolean
  // stop cancels one job by id, or every in-flight job when id is absent.
  stop: (id?: string) => void
  // stopping marks a stop request on the wire, so repeat clicks queue nothing.
  stopping: boolean
}

// useAgentJobs re-lists a session's sub-agent jobs while any job is live
// (chips visible or tallies nonzero) and right after a stop, per the pull
// contract: no event family carries job records, so reconnect needs no
// re-sync beyond the next list. Listing failures leave the last records up;
// the coded unavailable answer alone hides the surfaces, and a refused stop
// toasts.
export function useAgentJobs(
  sessionId: string,
  activity: ActivityRow[] | undefined,
  segments: Segment[] | undefined,
  onToast?: (text: string, level?: 'info' | 'error') => void,
): AgentJobs {
  const [byId, setById] = useState<Map<string, AgentJob>>(() => new Map())
  const [available, setAvailable] = useState(true)
  const [stopping, setStopping] = useState(false)
  const live = jobsLive(activity, segments)

  // list reads one listing; the coded unavailable answer alone hides the
  // surfaces, everything else stays silent since rows and counts stay
  // truthful via push.
  const list = useCallback(
    (signal?: AbortSignal) => {
      sessionAPI
        .agents(sessionId, signal)
        .then((res) => setById(new Map((res.jobs ?? []).map((job) => [job.id, job]))))
        .catch((err: unknown) => {
          if (signal?.aborted) return
          if (err instanceof ApiError && err.code === 'unavailable') setAvailable(false)
        })
    },
    [sessionId],
  )

  useEffect(() => {
    if (!live || !available) return
    const abort = new AbortController()
    list(abort.signal)
    const timer = setInterval(() => list(abort.signal), pollLiveMs)
    const onVisible = () => {
      if (document.visibilityState === 'visible') list(abort.signal)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      abort.abort()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [sessionId, live, available, list])

  const stop = useCallback(
    (id?: string) => {
      setStopping(true)
      sessionAPI
        .stopAgents(sessionId, id === undefined ? { all: true } : { id })
        .then(() => list()) // fresh records right after a stop
        .catch((err: unknown) => {
          onToast?.(err instanceof ApiError ? err.message : 'Stop failed.', 'error')
        })
        .finally(() => setStopping(false))
    },
    [sessionId, onToast, list],
  )

  return { byId, available, stop, stopping }
}

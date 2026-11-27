import { useCallback, useRef, useState } from 'react'

import { describeError } from '../api/errors'
import { sessions as sessionAPI } from '../api/endpoints'
import { useSwarm } from '../providers/swarm'

// useStop is the one session-stop path: POST the stop endpoint (it escalates
// on its own, /exit first then signals for swarm children), then refresh the
// roster so rows re-badge now. Every stop button shares this busy and error
// story, so a request-shape change lands in one place.
export function useStop(): {
  // overlapping calls are dropped while one is in flight
  stop: (sessionId: string) => Promise<void>
  stoppingId: string | null // target of the stop in flight, if any
  error: string
} {
  const { refreshSessions } = useSwarm()
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  // mirrors stoppingId synchronously, so an overlapping click cannot start a
  // second stop behind a button that has not re-rendered disabled yet
  const inflightRef = useRef(false)

  const stop = useCallback(
    async (sessionId: string): Promise<void> => {
      if (inflightRef.current) return
      inflightRef.current = true
      setStoppingId(sessionId)
      setError('')
      try {
        await sessionAPI.stop(sessionId)
        void refreshSessions() // rows re-badge now, not on the next poll
      } catch (err) {
        setError(describeError(err, 'Stop failed.'))
      } finally {
        inflightRef.current = false
        setStoppingId(null)
      }
    },
    [refreshSessions],
  )

  return { stop, stoppingId, error }
}

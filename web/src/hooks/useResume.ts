import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { describeError } from '../api/errors'
import { fleet } from '../api/endpoints'

// useResume is the one resume path for an ended session: launch headless
// --resume under its recorded workspace, then navigate to the new instance or
// hand it to onResumed when a screen reacts itself. Every resume button shares
// this busy and error story, so a request-shape change lands in one place.
export function useResume(onResumed?: (sessionId: string) => void | Promise<void>): {
  // overlapping calls are dropped while one is in flight
  resume: (workspace: string, target: string) => Promise<void>
  resumingId: string | null // target of the resume in flight, if any
  error: string
} {
  const navigate = useNavigate()
  const [resumingId, setResumingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  // onResumed rides a ref so resume stays stable across renders
  const onResumedRef = useRef(onResumed)
  useEffect(() => {
    onResumedRef.current = onResumed
  })
  // mirrors resumingId synchronously, so an overlapping click cannot start a
  // second launch behind a button that has not re-rendered disabled yet
  const inflightRef = useRef(false)

  const resume = useCallback(
    async (workspace: string, target: string): Promise<void> => {
      if (inflightRef.current) return
      inflightRef.current = true
      setResumingId(target)
      setError('')
      try {
        const res = await fleet.launch({ workspace, mode: 'resume', target })
        if (onResumedRef.current !== undefined) await onResumedRef.current(res.sessionId)
        else navigate(`/s/${encodeURIComponent(res.sessionId)}`)
      } catch (err) {
        setError(describeError(err, 'Resume failed.'))
      } finally {
        inflightRef.current = false
        setResumingId(null)
      }
    },
    [navigate],
  )

  return { resume, resumingId, error }
}

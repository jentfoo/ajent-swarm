import { useEffect, useMemo, useRef, useState } from 'react'

import { describeError } from '../api/errors'
import { fleet } from '../api/endpoints'
import type { Entry } from '../api/types'
import { deriveBlocks } from '../state/derive'
import { EntryBlock } from '../session/EntryBlock'

// TranscriptPreview renders a recorded session's transcript for offline run
// history: the newest window first, older pages fetched on demand through the
// same cursor paging the live entries endpoint uses.
export function TranscriptPreview({ sessionId }: { sessionId: string }) {
  const [pages, setPages] = useState<Entry[][]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  // Rides the reset below so a session switch retires an in-flight older page
  // from the previous session instead of prepending into the new one.
  const sessionToken = useRef(0)
  // A session switch resets the walk during render, React's documented reset
  // pattern. The effect then refetches against the fresh state.
  const [session, setSession] = useState(sessionId)
  if (session !== sessionId) {
    setSession(sessionId)
    setPages([])
    setCursor(undefined)
    setError('')
    setLoading(true)
    setLoadingOlder(false)
  }

  useEffect(() => {
    sessionToken.current++ // retires any older-page fetch of the prior session
    let alive = true
    fleet
      .savedEntries(sessionId)
      .then((page) => {
        if (!alive) return
        setPages([page.entries])
        setCursor(page.cursor)
        setError('')
      })
      .catch((err: unknown) => {
        if (alive) setError(describeError(err, 'Reading the transcript failed.'))
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [sessionId])

  const loadOlder = async () => {
    // The guard pins the cursor for this walk, so a double-click cannot fire
    // two fetches for the same page. A new session retires the fetch outright.
    if (loadingOlder || cursor === undefined || cursor === '') return
    const token = sessionToken.current
    setLoadingOlder(true)
    try {
      const { entries: older, cursor: next } = await fleet.savedEntries(sessionId, cursor)
      if (token !== sessionToken.current) return
      setPages((ps) => [older, ...ps])
      setCursor(next)
      setError('') // a prior failed page clears once a retry succeeds
    } catch (err) {
      if (token !== sessionToken.current) return
      setError(describeError(err, 'Reading the transcript failed.'))
    } finally {
      if (token === sessionToken.current) setLoadingOlder(false)
    }
  }

  const entries = useMemo(() => pages.flat(), [pages])
  const blocks = useMemo(
    () =>
      deriveBlocks(
        entries.map((e) => e.id),
        new Map(entries.map((e) => [e.id, e])),
      ),
    [entries],
  )

  return (
    <div className="transcript-preview" aria-label="Recorded transcript">
      {error !== '' && <p className="error-text">{error}</p>}
      {loading && <p className="muted">Loading the transcript…</p>}
      {!loading && entries.length === 0 && error === '' && (
        <p className="muted">This session recorded nothing.</p>
      )}
      {blocks.map((b) => (
        <EntryBlock key={b.id} block={b} />
      ))}
      {cursor ? (
        <button type="button" onClick={() => void loadOlder()} disabled={loadingOlder}>
          Load earlier history
        </button>
      ) : null}
    </div>
  )
}

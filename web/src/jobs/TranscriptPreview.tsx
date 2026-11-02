import { useEffect, useMemo, useState } from 'react'

import { ApiError } from '../api/client'
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

  useEffect(() => {
    let alive = true
    setPages([])
    setCursor(undefined)
    setLoading(true)
    fleet
      .savedEntries(sessionId)
      .then((page) => {
        if (!alive) return
        setPages([page.entries])
        setCursor(page.cursor)
        setError('')
      })
      .catch((err: unknown) => {
        if (alive)
          setError(err instanceof ApiError ? err.message : 'Reading the transcript failed.')
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [sessionId])

  const loadOlder = async () => {
    if (cursor === undefined || cursor === '') return
    let older: Entry[] = []
    let next: string | undefined
    try {
      ;({ entries: older, cursor: next } = await fleet.savedEntries(sessionId, cursor))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reading the transcript failed.')
      return
    }
    setPages((ps) => [older, ...ps])
    setCursor(next)
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
        <button type="button" onClick={() => void loadOlder()}>
          Load earlier history
        </button>
      ) : null}
    </div>
  )
}

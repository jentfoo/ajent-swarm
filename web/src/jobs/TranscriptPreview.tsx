import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'

import { describeError } from '../api/errors'
import { fleet } from '../api/endpoints'
import type { Entry } from '../api/types'
import { deriveBlocks } from '../state/derive'
import { EntryBlock } from '../session/EntryBlock'

// Scroll writes ride a module fn: the owner is often a caller's ref, which the
// immutability lint treats as a prop it may not see mutated inline.
function setScrollTop(el: HTMLElement, top: number) {
  el.scrollTop = top
}

// TranscriptPreview renders a recorded session's transcript for offline run
// history: the newest window first, older pages fetched on demand through the
// same cursor paging the live entries endpoint uses. The newest window opens
// on its latest entry and an older page prepends without moving the reader.
// `scrollOwner` names the element that scrolls this preview when a parent
// owns scrolling (the run-detail modal); absent, the preview's root scrolls.
export function TranscriptPreview({
  sessionId,
  scrollOwner,
}: {
  sessionId: string
  scrollOwner?: RefObject<HTMLElement | null>
}) {
  const [pages, setPages] = useState<Entry[][]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  // One-shot: the newest window's commit pins the reader to its latest entry.
  // Older pages, errors and pending flips never set it again.
  const pinRef = useRef(false)
  // Rides the reset below so a session switch retires an in-flight older page
  // from the previous session instead of prepending into the new one.
  const sessionToken = useRef(0)
  // The previously first block's id and viewport top, restored once an older
  // page commits so loading history never moves the reader.
  const anchorRef = useRef<{ id: string; top: number } | null>(null)

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

  const entries = useMemo(() => pages.flat(), [pages])
  const blocks = useMemo(
    () =>
      deriveBlocks(
        entries.map((e) => e.id),
        new Map(entries.map((e) => [e.id, e])),
      ),
    [entries],
  )

  useEffect(() => {
    // Bumping retires any older-page fetch of the prior session, this walk's
    // own fetch compares against the same token. The prior walk's prepend
    // anchor retires with it.
    const token = ++sessionToken.current
    anchorRef.current = null
    fleet
      .savedEntries(sessionId)
      .then((page) => {
        if (token !== sessionToken.current) return
        setPages([page.entries])
        setCursor(page.cursor)
        setError('')
        if (page.entries.length > 0) pinRef.current = true
      })
      .catch((err: unknown) => {
        if (token === sessionToken.current) {
          setError(describeError(err, 'Reading the transcript failed.'))
        }
      })
      .finally(() => token === sessionToken.current && setLoading(false))
  }, [sessionId])

  const loadOlder = async () => {
    // The guard pins the cursor for this walk, so a double-click cannot fire
    // two fetches for the same page. A new session retires the fetch outright.
    if (loadingOlder || cursor === undefined || cursor === '') return
    const token = sessionToken.current
    // the first block's viewport spot anchors the restore after the prepend
    const first = blocks[0]?.id
    const kept =
      first === undefined
        ? null
        : (rootRef.current?.querySelector(`[data-entry-id="${first}"]`) ?? null)
    anchorRef.current =
      first === undefined || kept === null
        ? null
        : { id: first, top: kept.getBoundingClientRect().top }
    setLoadingOlder(true)
    try {
      const { entries: older, cursor: next } = await fleet.savedEntries(sessionId, cursor)
      if (token !== sessionToken.current) return
      setPages((ps) => [older, ...ps])
      setCursor(next)
      setError('') // a prior failed page clears once a retry succeeds
    } catch (err) {
      if (token !== sessionToken.current) return
      anchorRef.current = null // no page lands, so no restore fires
      setError(describeError(err, 'Reading the transcript failed.'))
    } finally {
      if (token === sessionToken.current) setLoadingOlder(false)
    }
  }

  // The newest window lands the reader on its latest entry: the flag rides
  // the commit that rendered the entries and burns there, so nothing re-pins
  // afterwards.
  useLayoutEffect(() => {
    if (!pinRef.current) return
    pinRef.current = false
    if (blocks.length === 0) return
    const owner = scrollOwner === undefined ? rootRef.current : scrollOwner.current
    if (owner === null) return
    setScrollTop(owner, owner.scrollHeight)
  }, [blocks, scrollOwner])

  // Restores the captured spot once the older page is in the DOM: the anchored
  // block moved by exactly what prepended above it, and the scroller absorbs
  // the difference. A retired anchor (a failed page, a session swap) moves
  // nothing.
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (anchor === null) return
    anchorRef.current = null
    const kept = rootRef.current?.querySelector(`[data-entry-id="${anchor.id}"]`) ?? null
    const owner = scrollOwner === undefined ? rootRef.current : scrollOwner.current
    if (kept === null || owner === null) return
    setScrollTop(owner, owner.scrollTop + (kept.getBoundingClientRect().top - anchor.top))
  }, [blocks, scrollOwner])

  return (
    <div ref={rootRef} className="transcript-preview" aria-label="Recorded transcript">
      {/* the pager leads the entries, matching the live transcript's control */}
      {cursor ? (
        <button
          type="button"
          className="load-older"
          onClick={() => void loadOlder()}
          disabled={loadingOlder}
        >
          {loadingOlder ? 'Loading earlier history…' : 'Load earlier history'}
        </button>
      ) : null}
      {error !== '' && <p className="error-text">{error}</p>}
      {loading && (
        <p className="muted" role="status" aria-busy="true">
          Loading the transcript…
        </p>
      )}
      {!loading && entries.length === 0 && error === '' && (
        <p className="muted">This session recorded nothing.</p>
      )}
      {blocks.map((b) => (
        <EntryBlock key={b.id} block={b} />
      ))}
    </div>
  )
}

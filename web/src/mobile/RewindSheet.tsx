import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { RewindCandidate } from '../api/types'
import { BottomSheet } from './BottomSheet'

// maxRecent caps the flat list; older prompts stay reachable on desktop.
const maxRecent = 25

// RewindSheet presents rewind as a draggable bottom sheet with a flat list of
// recent prompts rather than the full tree, so the transcript stays visible
// behind the picks. Selecting one rewinds onto it and prefills its full prompt
// text into the composer for an edit — exactly the desktop dialog's contract,
// minus the tree.
export function RewindSheet({
  sessionId,
  open,
  onClose,
  onPrefill,
  onToast,
}: {
  sessionId: string
  open: boolean
  onClose: () => void
  onPrefill: (text: string) => void
  onToast: (text: string, level?: 'info' | 'error') => void
}): ReactElement | null {
  const [candidates, setCandidates] = useState<RewindCandidate[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    let alive = true
    sessionAPI
      .candidates(sessionId)
      .then((res) => {
        if (!alive) return
        setCandidates(res.candidates ?? [])
        setError('') // a fresh list supersedes any earlier load's failure
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof ApiError ? err.message : 'Loading rewind points failed.')
      })
    return () => {
      alive = false
    }
  }, [open, sessionId])

  if (!open) return null

  const recent = candidates
    .filter((c) => c.kind === 'user')
    .sort((a, b) => b.ts - a.ts)
    .slice(0, maxRecent)

  const pick = async (candidate: RewindCandidate) => {
    if (busyId !== null || candidate.isHead) return
    setBusyId(candidate.id)
    try {
      await sessionAPI.rewind(sessionId, candidate.id)
      onPrefill(candidate.text ?? '')
      onClose()
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Rewind refused.', 'error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} label="Rewind">
      <div className="rewind-list">
        {error && <p className="error-text">{error}</p>}
        {recent.length === 0 && !error && <p className="muted">No prompts to rewind to.</p>}
        {recent.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`card rewind-row ${c.isHead ? 'head' : ''}`}
            disabled={busyId !== null || c.isHead}
            onClick={() => void pick(c)}
            data-testid={`rewind-${c.id}`}
          >
            <span className="rewind-text">{c.text || '(empty prompt)'}</span>
            <span className="muted">
              {c.isHead ? 'current' : new Date(c.ts).toLocaleString()}
              {c.truncated ? ' · truncated' : ''}
            </span>
          </button>
        ))}
      </div>
    </BottomSheet>
  )
}

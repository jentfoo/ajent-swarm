import { useEffect, useState } from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { RewindCandidate, RewindKind } from '../api/types'

// RewindDialog offers the fork candidates GET /candidates derived: user
// prompts re-send, assistant replies and compaction targets are allowed, and
// everything else never lists. The current head is marked by the server; a
// refusal surfaces as a toast and the picker stays open.
export function RewindDialog({
  sessionId,
  onClose,
  onToast,
}: {
  sessionId: string
  onClose: () => void
  onToast: (text: string, level?: 'info' | 'error') => void
}) {
  const [candidates, setCandidates] = useState<RewindCandidate[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [busyId, setBusyId] = useState('')

  useEffect(() => {
    let alive = true
    sessionAPI
      .candidates(sessionId)
      .then((res) => {
        if (alive) setCandidates(res.candidates)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setLoadError(err instanceof ApiError ? err.message : 'Loading candidates failed.')
      })
    return () => {
      alive = false
    }
  }, [sessionId])

  const rewind = async (c: RewindCandidate) => {
    setBusyId(c.id)
    try {
      await sessionAPI.rewind(sessionId, c.id)
      onToast(`Rewound onto ${kindLabel(c.kind)}.`, 'info')
      onClose()
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Rewind refused.', 'error')
    } finally {
      setBusyId('')
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="card modal"
        role="dialog"
        aria-label="Rewind to an earlier point"
        onClick={(ev) => ev.stopPropagation()}
      >
        <h2 style={{ marginTop: 0, fontSize: 'inherit' }}>Rewind</h2>
        {candidates === null && !loadError && <p className="muted">Loading forks…</p>}
        {loadError && <p className="error-text">{loadError}</p>}
        {candidates !== null && candidates.length === 0 && (
          <p className="muted">Nothing rewirable yet: no prompts, replies or compactions.</p>
        )}
        <div className="rewind-list">
          {(candidates ?? []).map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={busyId !== ''}
              title={`${kindLabel(c.kind)}${c.isHead ? ' · current head' : ''}`}
              onClick={() => void rewind(c)}
            >
              <span className="badge">{kindLabel(c.kind)}</span>
              {c.isHead && <span className="badge accent">head</span>}
              <span className="rewind-label">{c.label || c.id}</span>
            </button>
          ))}
        </div>
        <div style={{ marginTop: '0.6em' }}>
          <button type="button" onClick={onClose}>
            Keep current history
          </button>
        </div>
      </div>
    </div>
  )
}

function kindLabel(kind: RewindKind): string {
  switch (kind) {
    case 'user':
      return 'prompt'
    case 'assistant':
      return 'reply'
    case 'compaction':
      return 'compaction'
    default:
      return kind
  }
}

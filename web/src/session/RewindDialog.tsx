import { useEffect, useState } from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { RewindCandidate, RewindKind } from '../api/types'
import { ModalShell } from '../ui/ModalShell'

// RewindDialog offers the fork candidates GET /candidates derived: user
// prompts re-send (their text prefills the composer for an edit), assistant
// replies and compaction targets are allowed, and everything else never
// lists. Rows render as the context tree the server laid out; a refusal
// surfaces as a toast and the picker stays open.
export function RewindDialog({
  sessionId,
  onClose,
  onToast,
  onPrefill,
}: {
  sessionId: string
  onClose: () => void
  onToast: (text: string, level?: 'info' | 'error') => void
  onPrefill: (text: string) => void
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
      if (c.text !== undefined && c.text !== '') {
        onPrefill(c.text) // rewinding a prompt opens it for editing
        if (c.truncated) onToast('The prompt was too large to prefill in full.', 'error')
      }
      onClose()
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Rewind refused.', 'error')
    } finally {
      setBusyId('')
    }
  }

  return (
    <ModalShell label="Rewind to an earlier point" onClose={onClose}>
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
            className={`rewind-row ${c.active ? 'active-branch' : ''}`}
            style={{ paddingLeft: `calc(${(c.depth ?? 0) * 1.1}em + 0.4em)` }}
            onClick={() => void rewind(c)}
          >
            <span className="badge">{kindLabel(c.kind)}</span>
            {c.isHead && <span className="badge accent">head</span>}
            {c.active && !c.isHead && <span className="badge ok-badge">current</span>}
            <span className="rewind-guide muted mono">{c.guide}</span>
            <span className="rewind-label">{c.label || c.id}</span>
          </button>
        ))}
      </div>
      <div style={{ marginTop: '0.6em' }}>
        <button type="button" onClick={onClose}>
          Keep current history
        </button>
      </div>
    </ModalShell>
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

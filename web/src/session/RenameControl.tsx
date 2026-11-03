import { useState } from 'react'
import type { FormEvent, ReactElement } from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import { useSwarm } from '../providers/swarm'

// RenameControl is the pencil affordance beside a session label: clicking it
// swaps in an inline editor that writes swarm's stored display title. An empty
// submit clears the title, falling labels back to names and paths. Ajent's own
// session names are never touched, so resume targets stay clean.
export function RenameControl({
  sessionId,
  label,
}: {
  sessionId: string
  label: string
}): ReactElement | null {
  const [editing, setEditing] = useState(false)

  if (editing) {
    return <RenameEditor sessionId={sessionId} initial={label} onDone={() => setEditing(false)} />
  }
  return (
    <button
      type="button"
      className="rename-control"
      aria-label={`Rename ${label}`}
      title="Rename this session"
      onClick={(ev) => {
        ev.stopPropagation()
        setEditing(true)
      }}
    >
      ✎
    </button>
  )
}

// RenameEditor submits once; saving refreshes the listing so every label
// re-renders without waiting out the poll.
function RenameEditor({
  sessionId,
  initial,
  onDone,
}: {
  sessionId: string
  initial: string
  onDone: () => void
}) {
  const { refreshSessions } = useSwarm()
  const [title, setTitle] = useState(initial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (ev: FormEvent) => {
    ev.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      await sessionAPI.setTitle(sessionId, title.trim())
      await refreshSessions() // labels update at once, not on the next poll
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Rename failed.')
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onDone} role="presentation">
      <form
        className="card modal rename-modal"
        onSubmit={(ev) => void submit(ev)}
        data-testid={`rename-${sessionId}`}
        onClick={(ev) => ev.stopPropagation()}
      >
        <label>
          Display title
          <input value={title} onChange={(ev) => setTitle(ev.target.value)} autoFocus />
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="rename-actions">
          <button type="submit" className="primary" disabled={busy}>
            Save
          </button>
          <button type="button" onClick={onDone} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

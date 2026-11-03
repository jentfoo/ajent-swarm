import { useState } from 'react'
import type { FormEvent, ReactElement } from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import { useSwarm } from '../providers/swarm'
import { useWorkspace } from '../providers/workspace'
import { useLongPress } from './useLongPress'
import type { SwitcherRow } from './switcher'

// SwitcherRows renders the sheet's large touch rows: status and needs-input
// badges beside each label, a check-off on actionable attention states (never
// on neutral waiting or ended rows), and long-press rename editing the stored
// swarm title — never ajent's own session names.
export function SwitcherRows({
  rows,
  onOpen,
}: {
  rows: SwitcherRow[]
  onOpen: (row: SwitcherRow) => void
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null)

  if (rows.length === 0) {
    return <p className="muted sheet-empty">No sessions yet. Launch one below.</p>
  }
  return (
    <div className="switcher-rows" role="list">
      {rows.map((row) =>
        renamingId === row.sessionId ? (
          <RenameEditor key={row.sessionId} row={row} onDone={() => setRenamingId(null)} />
        ) : (
          <SwitchRow
            key={row.sessionId}
            row={row}
            onOpen={onOpen}
            onRename={() => setRenamingId(row.sessionId)}
          />
        ),
      )}
    </div>
  )
}

function SwitchRow({
  row,
  onOpen,
  onRename,
}: {
  row: SwitcherRow
  onOpen: (row: SwitcherRow) => void
  onRename: () => void
}) {
  const { itemFor, acknowledgeItem } = useWorkspace()
  // pressed styles the row; the handlers spread without it
  const { pressed, ...pressProps } = useLongPress(onRename)
  // the check-off resolves live from the digest so a settled row never offers one
  const item = itemFor(row.sessionId)
  const canCheckOff =
    row.checkOff &&
    item !== undefined &&
    (item.kind === 'needs-input' || item.kind === 'needs-review')

  return (
    <div
      role="listitem"
      className={`switch-row ${pressed ? 'pressed' : ''} status-${row.status}`}
      data-session-id={row.sessionId}
      onClick={() => onOpen(row)}
      {...pressProps}
    >
      <span className="switch-top">
        <span className="switch-name">{row.label}</span>
        <StatusBadge status={row.status} />
        {row.needsInput && (
          <span className="badge danger" aria-label={`${row.sessionId} needs input`}>
            input
          </span>
        )}
      </span>
      <span className="switch-bottom">
        {row.reason !== '' ? <span className="muted switch-reason">{row.reason}</span> : null}
        {canCheckOff && (
          <button
            type="button"
            className="rail-check"
            aria-label={`Mark ${row.label} reviewed`}
            onClick={(ev) => {
              ev.stopPropagation()
              if (item) acknowledgeItem(item)
            }}
          >
            ✓
          </button>
        )}
      </span>
    </div>
  )
}

function StatusBadge({ status }: { status: SwitcherRow['status'] }): ReactElement {
  switch (status) {
    case 'running':
      return <span className="badge accent">running</span>
    case 'waiting':
      return <span className="badge">waiting</span>
    case 'ended':
      return <span className="badge danger">ended</span>
    default:
      return <span className="badge">idle</span>
  }
}

// RenameEditor edits the swarm-side display title inline. Submitting empty
// clears the stored title, falling labels back to names and paths.
function RenameEditor({ row, onDone }: { row: SwitcherRow; onDone: () => void }) {
  const { refreshSessions } = useSwarm()
  const [title, setTitle] = useState(row.label)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (ev: FormEvent) => {
    ev.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      await sessionAPI.setTitle(row.sessionId, title.trim())
      await refreshSessions() // rows re-label immediately, not on the next poll
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Rename failed.')
      setBusy(false)
    }
  }

  return (
    <form
      className="card rename-editor"
      onSubmit={(ev) => void submit(ev)}
      data-testid={`rename-${row.sessionId}`}
    >
      <label>
        Display title
        <input value={title} onChange={(ev) => setTitle(ev.target.value)} autoFocus />
      </label>
      {error && <p className="error-text">{error}</p>}
      <div style={{ display: 'flex', gap: '0.5em' }}>
        <button type="submit" disabled={busy}>
          Save
        </button>
        <button type="button" onClick={onDone} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  )
}

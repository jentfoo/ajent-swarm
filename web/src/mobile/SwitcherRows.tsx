import { Fragment, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import { useNavigate } from 'react-router'

import { ApiError } from '../api/client'
import { fleet as fleetAPI, sessions as sessionAPI } from '../api/endpoints'
import { useSwarm } from '../providers/swarm'
import { useWorkspace } from '../providers/workspace'
import { SettingsSheet } from './SettingsSheet'
import { useLongPress } from './useLongPress'
import { groupSwitcherRows } from './switcher'
import type { SwitcherRow } from './switcher'

// SwitcherRows renders the sheet's large touch rows grouped under the desktop
// rail's headings (Needs input, Working, Recent): status and needs-input
// badges beside each label, a check-off on actionable attention states (never
// on neutral waiting or ended rows), a trailing actions area mirroring the
// desktop card bar minus Open, and long-press rename editing the stored swarm
// title rather than ajent's own session names.
export function SwitcherRows({
  rows,
  onOpen,
}: {
  rows: SwitcherRow[]
  onOpen: (row: SwitcherRow) => void
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [settingsId, setSettingsId] = useState<string | null>(null)

  if (rows.length === 0) {
    return <p className="muted sheet-empty">No sessions yet. Launch one below.</p>
  }
  const sections = groupSwitcherRows(rows)
  return (
    <div className="switcher-rows" role="list">
      {sections.map((group) => (
        <Fragment key={group.section}>
          <div className="rail-section-title">
            {group.title} <span className="muted">({group.rows.length})</span>
          </div>
          {group.rows.map((row) => (
            <SwitchRow
              key={row.sessionId}
              row={row}
              onOpen={onOpen}
              onRename={() => setRenamingId(row.sessionId)}
              onSettings={() => setSettingsId(row.sessionId)}
            />
          ))}
        </Fragment>
      ))}
      {/* the editor rides above the rows as a modal, like every other surface */}
      {renamingId !== null && (
        <RenameEditor
          row={rows.find((r) => r.sessionId === renamingId)!}
          onDone={() => setRenamingId(null)}
        />
      )}
      {/* one pushed settings screen, rebound to whichever row was tapped */}
      {settingsId !== null && (
        <SettingsSheet sessionId={settingsId} open onClose={() => setSettingsId(null)} />
      )}
    </div>
  )
}

function SwitchRow({
  row,
  onOpen,
  onRename,
  onSettings,
}: {
  row: SwitcherRow
  onOpen: (row: SwitcherRow) => void
  onRename: () => void
  onSettings: () => void
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
      <RowActions row={row} onSettings={onSettings} />
    </div>
  )
}

// RowActions is the row's trailing action area, mirroring the desktop card's
// bar minus Open (the row itself opens): Settings and Stop for live rows,
// Resume for ended ones with a recorded workspace. It swallows clicks and
// pointer-downs so tapping or holding an action never reads as the row's own
// open or long-press gestures.
function RowActions({ row, onSettings }: { row: SwitcherRow; onSettings: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { refreshSessions } = useSwarm()
  const navigate = useNavigate()
  const ended = row.status === 'ended'

  if (ended && !row.workspace) return null // resume needs the working directory back

  const stop = async () => {
    setBusy(true)
    setError('')
    try {
      await sessionAPI.stop(row.sessionId)
      await refreshSessions() // rows re-badge now, not on the next poll
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Stop failed.')
    } finally {
      setBusy(false)
    }
  }

  const resume = async () => {
    setBusy(true)
    setError('')
    try {
      const res = await fleetAPI.launch({
        workspace: row.workspace!, // guarded above, ended rows only
        mode: 'resume',
        target: row.sessionId,
      })
      navigate(`/s/${encodeURIComponent(res.sessionId)}`)
    } catch (err) {
      setBusy(false)
      setError(err instanceof ApiError ? err.message : 'Resume failed.')
    }
  }

  return (
    <div
      className="switch-actions"
      onClick={(ev) => ev.stopPropagation()}
      onPointerDown={(ev) => ev.stopPropagation()}
    >
      {ended ? (
        <button type="button" onClick={() => void resume()} disabled={busy}>
          {busy ? 'Resuming…' : 'Resume'}
        </button>
      ) : (
        <>
          <button type="button" onClick={onSettings}>
            Settings
          </button>
          <button type="button" onClick={() => void stop()} disabled={busy}>
            {busy ? 'Stopping…' : 'Stop'}
          </button>
        </>
      )}
      {error && <span className="error-text">{error}</span>}
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

// RenameEditor edits the swarm-side display title in a centered modal.
// Submitting empty clears the stored title, falling labels back to names and
// paths.
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
    <div className="modal-backdrop" onClick={onDone} role="presentation">
      <form
        className="card modal rename-modal"
        onSubmit={(ev) => void submit(ev)}
        data-testid={`rename-${row.sessionId}`}
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

import { Fragment, useState } from 'react'
import type { ReactElement } from 'react'

import { describeError } from '../api/errors'
import { sessions as sessionAPI } from '../api/endpoints'
import { useArmedConfirm } from '../hooks/useArmedConfirm'
import { useResume } from '../hooks/useResume'
import { RenameEditorModal } from '../session/RenameControl'
import { StatusBadge } from '../session/StatusBadge'
import { useSwarm } from '../providers/swarm'
import { useWorkspace } from '../providers/workspace'
import { instanceKey, isActionable } from '../workspace/attention'
import { SettingsScreen } from './SettingsScreen'
import { useLongPress } from './useLongPress'
import { useOverlayBack } from '../ui/useOverlayBack'
import { groupSwitcherRows } from './switcher'
import type { SwitcherRow } from './switcher'

// SwitcherRows renders the sheet's large touch rows grouped under the
// shared rail headings plus the Recent tail: status and needs-input badges
// beside each label plus a queued-prompt count when prompts wait, a
// check-off on actionable attention states (never on neutral waiting or ended
// rows), a trailing actions area mirroring the desktop card bar minus Open
// plus an explicit Rename, and long-press rename opening the same editor.
// Both rename paths edit the stored swarm title rather than ajent's own
// session names, and platform back peels the editor alone, leaving the sheet
// beneath intact.
export function SwitcherRows({
  rows,
  onOpen,
}: {
  rows: SwitcherRow[]
  onOpen: (row: SwitcherRow) => void
}) {
  // the row itself, not its id, so a listing refresh can never crash the
  // editor with a lookup miss
  const [renaming, setRenaming] = useState<SwitcherRow | null>(null)
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
              key={instanceKey(row.sessionId, row.pid)}
              row={row}
              onOpen={onOpen}
              onRename={() => setRenaming(row)}
              onSettings={() => setSettingsId(row.sessionId)}
            />
          ))}
        </Fragment>
      ))}
      {/* the shared rename editor (session/RenameControl) rides above the
          rows as a modal, like every other surface, and as its own history
          layer on phones */}
      {renaming !== null && <RenameLayer row={renaming} onDone={() => setRenaming(null)} />}
      {/* one pushed settings screen, rebound to whichever row was tapped */}
      {settingsId !== null && (
        <SettingsScreen sessionId={settingsId} open onClose={() => setSettingsId(null)} />
      )}
    </div>
  )
}

// RenameLayer mounts the open editor as its own history layer, so platform
// back peels the editor while the sheet beneath stays put; the shared
// RenameEditorModal itself stays desktop-neutral.
function RenameLayer({ row, onDone }: { row: SwitcherRow; onDone: () => void }): ReactElement {
  useOverlayBack(onDone)
  return <RenameEditorModal sessionId={row.sessionId} initial={row.label} onDone={onDone} />
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
  const canCheckOff = row.checkOff && item !== undefined && isActionable(item.kind)

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
        {row.queued > 0 && <span className="badge">{row.queued} queued</span>}
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
      <RowActions row={row} onRename={onRename} onSettings={onSettings} />
    </div>
  )
}

// RowActions is the row's trailing action area, mirroring the desktop card's
// bar minus Open (the row itself opens): Rename on every row, Settings and
// Stop for live rows, Resume for ended ones with a recorded workspace. Stop
// carries the shared danger variant and arm/confirm guard; like the desktop
// card it holds across listing polls, while a relaunch resets it by remounting
// this row under a fresh instance key. It swallows clicks and
// pointer-downs so tapping or holding an action never reads as the row's own
// open or long-press gestures.
function RowActions({
  row,
  onRename,
  onSettings,
}: {
  row: SwitcherRow
  onRename: () => void
  onSettings: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [stopError, setStopError] = useState('')
  const { refreshSessions } = useSwarm()
  const { resume, resumingId, error } = useResume()
  const ended = row.status === 'ended'

  const stop = async () => {
    setBusy(true)
    setStopError('')
    try {
      await sessionAPI.stop(row.sessionId)
      await refreshSessions() // rows re-badge now, not on the next poll
    } catch (err) {
      setStopError(describeError(err, 'Stop failed.'))
    } finally {
      setBusy(false)
    }
  }

  // no resetKey: polls rebuild row objects every couple of seconds, so an
  // object key would void the arm between taps; instance swaps remount this
  // row disarmed instead
  const confirm = useArmedConfirm(() => void stop(), { disabled: busy })

  return (
    <div
      className="switch-actions"
      onClick={(ev) => ev.stopPropagation()}
      onPointerDown={(ev) => ev.stopPropagation()}
    >
      <button type="button" onClick={onRename}>
        Rename
      </button>
      {ended ? (
        row.workspace && (
          <button
            type="button"
            disabled={resumingId !== null}
            onClick={() => void resume(row.workspace!, row.sessionId)}
          >
            {resumingId === row.sessionId ? 'Resuming…' : 'Resume'}
          </button>
        )
      ) : (
        <>
          <button type="button" onClick={onSettings}>
            Settings
          </button>
          <button
            type="button"
            className={`danger${confirm.armed ? ' armed' : ''}`}
            onClick={confirm.onClick}
            onBlur={confirm.onBlur}
            disabled={busy}
          >
            {busy ? 'Stopping…' : confirm.armed ? 'Stop?' : 'Stop'}
          </button>
        </>
      )}
      {(error || stopError) && <span className="error-text">{error || stopError}</span>}
    </div>
  )
}

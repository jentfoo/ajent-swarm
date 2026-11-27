import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { RenameEditorModal } from '../session/RenameControl'
import { tildePath } from '../session/names'
import { SessionContextMenu, useSessionMenu } from '../session/SessionContextMenu'
import { CheckIcon, MoreHorizontalIcon } from '../ui/icons'
import { StatusBadge } from '../session/StatusBadge'
import { useSessionNamer } from '../session/useSessionLabel'
import { useResume } from '../hooks/useResume'
import { useStop } from '../hooks/useStop'
import { useArmedConfirm } from '../hooks/useArmedConfirm'
import { useAuth } from '../providers/auth'
import { useWorkspace } from '../providers/workspace'
import { chainNoticeOf, instanceKey, isActionable } from '../workspace/attention'
import { SettingsScreen } from './SettingsScreen'
import { ChainPickerScreen } from './ChainScreens'
import { useLongPress } from './useLongPress'
import { useOverlayBack } from '../ui/useOverlayBack'
import { groupSwitcherRows } from './switcher'
import type { SwitcherRow } from './switcher'

// SwitcherRows renders the launcher's touch rows grouped under the shared rail
// headings plus the Recent tail: the name, status and queued-count badges on
// the first line with the workspace path and reason line beneath, a check-off
// riding the reason line on actionable attention states (never on neutral
// waiting or ended rows), and one ⋯ trigger holding the trailing edge, opening
// the shared session menu at the button (agent settings, queue follow-up,
// chain after, rename) so none of them depend on a long press. The row
// itself opens on tap; its Open control stays in the tree for keyboard and
// screen reader users and reveals itself on keyboard focus. Stopping is
// common enough to sit on the row: live rows carry an armed inline Stop like
// ended rows keep an inline Resume, the menu has neither and it is the
// primary action there. A held drag lifts its row and chains it onto the row
// released under the finger, the same drop the desktop rail takes; rename
// edits the stored swarm title rather than ajent's own session names, and
// platform back peels the editor alone, leaving the rows beneath intact.
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
  const [chainParent, setChainParent] = useState<SwitcherRow | null>(null)
  // the live held drag across rows: its source row and the row under the
  // finger, lifted state so every row can highlight itself as the target
  const [drag, setDrag] = useState<{ childId: string; target: string | null } | null>(null)
  const { setChainDraft, setQueueDraft } = useWorkspace()
  // only alive rows chain, the same reachable set the desktop picker offers
  const chainableIds = useMemo(
    () => new Set(rows.filter((r) => r.status !== 'ended').map((r) => r.sessionId)),
    [rows],
  )

  if (rows.length === 0) {
    return <p className="muted rows-empty">No sessions yet. Launch one below.</p>
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
              drag={drag}
              chainableIds={chainableIds}
              onOpen={onOpen}
              onRename={() => setRenaming(row)}
              onSettings={() => setSettingsId(row.sessionId)}
              onChain={() => setChainParent(row)}
              onDragStart={() => setDrag({ childId: row.sessionId, target: null })}
              onDragTarget={(target) => setDrag((cur) => (cur === null ? cur : { ...cur, target }))}
              onDragEnd={() => setDrag(null)}
              onDrop={(parentId) => {
                setDrag(null)
                setChainDraft({ parentId, childId: row.sessionId })
              }}
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
      {/* the chain target picker rides above the rows as its own pushed
          screen, picking one lands the shared draft and the editor screen
          takes over */}
      {chainParent !== null && (
        <ChainPickerScreen
          parentId={chainParent.sessionId}
          onClose={() => setChainParent(null)}
          onPick={(childId) => {
            setChainParent(null)
            setChainDraft({ parentId: chainParent.sessionId, childId })
          }}
          onQueueNew={() => {
            setChainParent(null)
            setQueueDraft({ parentId: chainParent.sessionId })
          }}
        />
      )}
    </div>
  )
}

// RenameLayer mounts the open editor as its own history layer, so platform
// back peels the editor while the rows beneath stay put, the shared
// RenameEditorModal itself stays desktop-neutral.
function RenameLayer({ row, onDone }: { row: SwitcherRow; onDone: () => void }): ReactElement {
  useOverlayBack(onDone)
  return <RenameEditorModal sessionId={row.sessionId} initial={row.label} onDone={onDone} />
}

// SwitchRow renders one launcher row: a shrinking text column (name, badges,
// path, reason with its check-off) beside the trailing action edge. The row
// itself opens on tap while the Open control inside gives keyboard users the
// same activation, and the ⋯ trigger opens the shared session menu at the
// button, carrying the row's agent settings, rename, queue and chain.
function SwitchRow({
  row,
  drag,
  chainableIds,
  onOpen,
  onRename,
  onSettings,
  onChain,
  onDragStart,
  onDragTarget,
  onDragEnd,
  onDrop,
}: {
  row: SwitcherRow
  drag: { childId: string; target: string | null } | null
  chainableIds: ReadonlySet<string>
  onOpen: (row: SwitcherRow) => void
  onRename: () => void
  onSettings: () => void
  onChain: () => void
  onDragStart: () => void
  onDragTarget: (sessionId: string | null) => void
  onDragEnd: () => void
  onDrop: (parentId: string) => void
}) {
  const { itemFor, acknowledgeItem } = useWorkspace()
  const auth = useAuth()
  const nameFor = useSessionNamer()
  const { menu, openSessionMenuAt, closeSessionMenu } = useSessionMenu()
  const ended = row.status === 'ended'
  // pressed styles the row, the handlers spread without it; the hold opens
  // the shared session menu at the press point, and on live rows the same
  // held press converts into a chain drag once it moves
  const { pressed, dragging, ...pressProps } = useLongPress(
    (x, y) => openSessionMenuAt(x, y, row.sessionId),
    ended
      ? undefined
      : {
          canDrop: (id) => id !== row.sessionId && chainableIds.has(id),
          // the drag takes over the held press, its menu closes and the
          // launcher learns the live drag it highlights targets under
          onDragStart: () => {
            closeSessionMenu()
            onDragStart()
          },
          onDragTarget,
          onDrop,
          onDragEnd,
        },
  )
  // the check-off resolves live from the digest so a settled row never offers one
  const item = itemFor(row.sessionId)
  const canCheckOff = row.checkOff && item !== undefined && isActionable(item.kind)
  // a row the listing drops mid-drag still ends it, no row keeps a stale
  // target highlight; the ref keeps the once-registered cleanup current
  const endDragRef = useRef(onDragEnd)
  useEffect(() => {
    endDragRef.current = onDragEnd
  })
  useEffect(() => () => endDragRef.current(), [])
  // the chain role leads the reason line: a queued follow-up names its parent,
  // the shared derivation the desktop rail reads too
  const chain = item !== undefined ? chainNoticeOf(item, nameFor) : undefined

  return (
    <div
      role="listitem"
      className={`switch-row ${pressed ? 'pressed' : ''} status-${row.status} ${
        dragging ? 'chain-source' : ''
      } ${drag?.target === row.sessionId ? 'chain-target' : ''}`}
      data-session-id={row.sessionId}
      onClick={() => onOpen(row)}
      {...pressProps}
    >
      <span className="switch-main">
        <span className="switch-top">
          <span className="switch-name">{row.label}</span>
          <StatusBadge status={row.status} />
          {row.queued > 0 && <span className="badge">{row.queued} queued</span>}
        </span>
        {/* the path sub-line mirrors the desktop rail row: full tilde-folded
            workspace, hover title carries the absolute directory */}
        {row.workspace && (
          <span className="rail-path muted" title={row.workspace}>
            {tildePath(row.workspace, auth.home)}
          </span>
        )}
        <span className="switch-bottom">
          {chain !== undefined ? (
            <span className="muted switch-reason">{chain}</span>
          ) : (
            row.reason !== '' && <span className="muted switch-reason">{row.reason}</span>
          )}
          {canCheckOff && (
            <button
              type="button"
              className="rail-check icon-btn"
              aria-label={`Mark ${row.label} reviewed`}
              onClick={(ev) => {
                ev.stopPropagation()
                if (item) acknowledgeItem(item)
              }}
            >
              <CheckIcon />
            </button>
          )}
        </span>
      </span>
      <RowActions
        row={row}
        onOpen={() => onOpen(row)}
        onMenuAt={(x, y) => openSessionMenuAt(x, y, row.sessionId)}
      />
      <SessionContextMenu
        menu={menu}
        onClose={closeSessionMenu}
        onRename={onRename}
        onChain={onChain}
        onSettings={onSettings}
        stop={false} // the row carries its own armed stop
      />
    </div>
  )
}

// RowActions is the row's trailing edge: the keyboard entry's Open control in
// its focus-reveal slot, the state's own verb -- armed Stop on live rows,
// Resume on ended ones with a recorded workspace (the menu carries neither) --
// and the ⋯ trigger opening the shared session menu at the button, so agent
// settings, rename, queue follow-up and chain never depend on a held gesture.
// It swallows clicks and pointer-downs so tapping or holding an action never
// reads as the row's own open or long-press gestures. A refused resume or stop
// reports on its own line under the row.
function RowActions({
  row,
  onOpen,
  onMenuAt,
}: {
  row: SwitcherRow
  onOpen: () => void
  onMenuAt: (x: number, y: number) => void
}): ReactElement {
  const { resume, resumingId, error } = useResume()
  const { stop, stoppingId, error: stopError } = useStop()
  // the same armed guard the cards' stop buttons carry: the first click asks,
  // a second within the window stops
  const confirm = useArmedConfirm(() => void stop(row.sessionId), {
    disabled: stoppingId !== null,
  })

  return (
    <>
      <div
        className="switch-actions switch-trailing"
        onClick={(ev) => ev.stopPropagation()}
        onPointerDown={(ev) => ev.stopPropagation()}
      >
        {/* the slot reserves the pill's place, so its focus reveal never reflows
            the row */}
        <span className="switch-open-slot">
          <button type="button" className="switch-open" onClick={onOpen}>
            Open
          </button>
        </span>
        {row.status === 'ended' ? (
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
          <button
            type="button"
            className={`danger${confirm.armed ? ' armed' : ''}`}
            onClick={confirm.onClick}
            onBlur={confirm.onBlur}
            disabled={stoppingId !== null}
          >
            {stoppingId === row.sessionId ? 'Stopping…' : confirm.armed ? 'Stop?' : 'Stop'}
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          aria-label={`More actions for ${row.label}`}
          aria-haspopup="menu"
          onClick={(ev) => {
            // the menu anchors at the button's foot like a long press does at
            // the finger, placeMenu adding its own gap and viewport flips
            const box = ev.currentTarget.getBoundingClientRect()
            onMenuAt(box.left, box.bottom)
          }}
        >
          <MoreHorizontalIcon />
        </button>
      </div>
      {error !== '' && <span className="error-text">{error}</span>}
      {stopError !== '' && <span className="error-text">{stopError}</span>}
    </>
  )
}

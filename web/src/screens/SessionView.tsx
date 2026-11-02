import { useCallback, useRef, useState } from 'react'
import { useParams } from 'react-router'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import { useSessionChannel } from '../hooks/useSessionChannel'
import type { SessionPhase } from '../stream/swarmStream'
import { useWorkspace } from '../providers/workspace'
import { Composer } from '../session/Composer'
import { DialogDock } from '../session/DialogDock'
import { QueuedPrompts } from '../session/QueuedPrompts'
import { StatusHeader } from '../session/StatusHeader'
import { TranscriptView } from '../session/TranscriptView'
import { RewindDialog } from '../session/RewindDialog'
import type { AppliedSessionState, NoticeView } from '../state/eventApplier'

interface Toast {
  id: number
  text: string
  level: 'info' | 'error'
}

// SessionView is the single-session experience: status header with controls,
// virtualized transcript over reconciled state, dialog dock above a
// queue-aware composer. The workspace modes host it by sessionId; the
// /s/:sessionId route keeps a standalone focused view for deep links.
export default function SessionView({ sessionId: hostedId }: { sessionId?: string }) {
  const params = useParams()
  const sessionId = hostedId ?? params.sessionId ?? ''
  const { state, phase, loadOlder, dispatch } = useSessionChannel(sessionId)
  const { acknowledgeDialog, acknowledgeTurn } = useWorkspace()
  const snap = state.snapshot

  const [draft, setDraft] = useState('')
  const [showRewind, setShowRewind] = useState(false)

  const [toasts, setToasts] = useState<Toast[]>([])
  const toastID = useRef(0)
  const pushToast = useCallback((text: string, level: 'info' | 'error' = 'info') => {
    const id = ++toastID.current
    setToasts((ts) => [...ts.slice(-4), { id, text, level }])
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 6_000)
  }, [])

  // Editing a queued prompt pops it back into the composer through recall;
  // secret rows refuse upstream and their toast says so.
  const recallToEdit = useCallback(async () => {
    try {
      const row = await sessionAPI.recall(sessionId)
      if (row.text) setDraft(row.text)
    } catch (err) {
      pushToast(err instanceof ApiError ? err.message : 'Recall failed.', 'error')
    }
  }, [sessionId, pushToast])

  // Wire refusals while a dialog holds input mirror into the composer's
  // disabled state; every other coded refusal surfaces as a toast.
  const dialogs = snap.interactions ?? []
  const composerDisabled = phase !== 'live' || dialogs.length > 0
  const disabledReason =
    dialogs.length > 0
      ? 'A dialog needs an answer before prompts can send.'
      : 'The session is not reachable right now.'

  return (
    <div className="session-screen">
      <StatusHeader sessionId={sessionId} snap={snap} onToast={pushToast}>
        <SeatBadge sessionId={sessionId} state={state} />
        <button type="button" onClick={() => setShowRewind(true)}>
          Rewind
        </button>
      </StatusHeader>

      {phase !== 'live' && phase !== 'ended' && (
        <div className="banner info" role="status">
          {phaseText(phase)}
        </div>
      )}
      {(phase === 'ended' || state.exitReason !== undefined) && (
        <div className="banner warn" role="status">
          Session ended{state.exitReason ? `: ${state.exitReason}` : '.'}
        </div>
      )}

      <TranscriptView state={state} loadOlder={loadOlder} />

      {state.notices.length > 0 && <Notices notices={state.notices} />}
      <DialogDock
        sessionId={sessionId}
        dialogs={dialogs}
        outcomes={state.resolvedElsewhere}
        onAnsweredLocally={(dialogId) => {
          dispatch({ type: 'dialogAnswered', dialogId })
          acknowledgeDialog(sessionId, dialogId) // acting clears the inbox row
        }}
      />
      <QueuedPrompts
        queuedRows={snap.queuedRows ?? []}
        pendings={state.pendings}
        droppedRows={state.droppedRows}
        onEdit={() => void recallToEdit()}
      />
      {showRewind && (
        <RewindDialog
          sessionId={sessionId}
          onClose={() => setShowRewind(false)}
          onToast={pushToast}
          onPrefill={setDraft} // a rewound prompt lands in the composer to edit
        />
      )}
      <Composer
        sessionId={sessionId}
        value={draft}
        onChange={setDraft}
        disabled={composerDisabled}
        disabledReason={disabledReason}
        onSubmit={(line, pendingId) => {
          dispatch({ type: 'pendingSubmitted', pendingId, text: line })
          // Sending feedback counts as acting: any unreviewed completion
          // before now is settled, a later turn will re-raise.
          acknowledgeTurn(sessionId, Date.now())
        }}
        onSubmitFailed={(pendingId) => dispatch({ type: 'pendingFailed', pendingId })}
      />

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}

// SeatBadge keeps the seat facts visible with a one-click takeover.
function SeatBadge({ sessionId, state }: { sessionId: string; state: AppliedSessionState }) {
  const [busy, setBusy] = useState(false)
  const seat = state.snapshot.seat

  const takeControl = async () => {
    setBusy(true)
    try {
      await sessionAPI.takeControl(sessionId)
    } catch {
      // Refusals keep their holder name; the next snapshot updates the badge.
    } finally {
      setBusy(false)
    }
  }

  if (!seat.held) return <span className="badge">seat free</span>
  if (seat.yours) return null // swarm holds it for every viewer here
  return (
    <>
      <span className="badge warn">seat: {seat.holder || 'another controller'}</span>
      <button type="button" onClick={() => void takeControl()} disabled={busy}>
        Take control
      </button>
    </>
  )
}

function Notices({ notices }: { notices: NoticeView[] }) {
  return (
    <div aria-label="Notices">
      {notices.slice(-3).map((n, i) => (
        <div key={`${i}-${n.key}`} className={`block-notice ${n.level}`}>
          {n.text}
        </div>
      ))}
    </div>
  )
}

function phaseText(phase: SessionPhase): string {
  switch (phase) {
    case 'connecting':
      return 'Connecting to the session stream…'
    case 'resyncing':
      return 'Connection was interrupted; resnapshotting…'
    case 'lost':
      return 'The session is not reachable right now. It will reappear when its control socket serves again.'
    default:
      return ''
  }
}

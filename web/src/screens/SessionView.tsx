import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import { useSessionChannel } from '../hooks/useSessionChannel'
import type { SessionPhase } from '../stream/swarmStream'
import { useWorkspace } from '../providers/workspace'
import { Composer } from '../session/Composer'
import { DialogDock } from '../session/DialogDock'
import { QueuedPrompts } from '../session/QueuedPrompts'
import { StatusBar } from '../session/StatusBar'
import { StatusHeader } from '../session/StatusHeader'
import { TranscriptView } from '../session/TranscriptView'
import { RewindDialog } from '../session/RewindDialog'
import type { AppliedSessionState, NoticeView } from '../state/eventApplier'

interface Toast {
  id: number
  text: string
  level: 'info' | 'error'
}

// SessionView is the single-session experience: slim status header with
// controls, virtualized transcript over reconciled state, dialog dock above a
// queue-aware composer, and a bottom status bar answering "what is the agent
// doing" at a glance. The workspace modes host it by sessionId; the
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

      <TranscriptView sessionId={sessionId} state={state} loadOlder={loadOlder} />

      {state.notices.length > 0 && <Notices notices={state.notices} />}
      <DialogDock
        sessionId={sessionId}
        dialogs={dialogs}
        outcomes={state.resolvedElsewhere}
        onAnsweredLocally={(dialogId) => {
          dispatch({ type: 'dialogAnswered', dialogId })
          acknowledgeDialog(sessionId, dialogId) // acting clears the inbox row
        }}
        onOutcomeDismissed={(dialogId) => dispatch({ type: 'outcomeDismissed', dialogId })}
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

      <StatusBar snap={snap} live={state.live} />

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

// SeatBadge is the takeover affordance for a seat another controller holds.
// A free seat needs no claim (writes take it lazily) and one we hold needs no
// badge, so both stay hidden and control only ever shows as contested.
function SeatBadge({ sessionId, state }: { sessionId: string; state: AppliedSessionState }) {
  const [busy, setBusy] = useState(false)
  const seat = state.snapshot.seat

  if (!seat.held || seat.yours) return null

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

  return (
    <button
      type="button"
      className="badge warn seat-badge"
      disabled={busy}
      title={`Take control from ${seat.holder || 'another controller'}`}
      onClick={() => void takeControl()}
    >
      {`take control: ${seat.holder || 'held'}`}
    </button>
  )
}

// noticeTtlMs bounds how long a streamed notice stays visible: upstream's
// keyed lines replace each other but nothing ever clears them, so without an
// expiry "Sub-agent sub-6 completed" parks under the composer forever.
const noticeTtlMs = 8_000

function Notices({ notices }: { notices: NoticeView[] }) {
  const [now, setNow] = useState(() => Date.now())
  // a slow tick re-renders so expired lines leave without a new event arriving;
  // the interval only runs while fresh lines exist
  useEffect(() => {
    if (notices.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [notices.length])
  const fresh = notices.filter((n) => now - n.at < noticeTtlMs)
  if (fresh.length === 0) return null
  return (
    <div aria-label="Notices">
      {fresh.slice(-3).map((n, i) => (
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

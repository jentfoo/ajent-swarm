import { useCallback, useRef, useState } from 'react'
import { useParams } from 'react-router'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import { useSessionChannel } from '../hooks/useSessionChannel'
import { useWorkspace } from '../providers/workspace'
import { Composer } from '../session/Composer'
import { placedAboveNotice, useComposerDraft } from '../session/useComposerDraft'
import { phaseText } from '../session/phases'
import { DialogDock } from '../session/DialogDock'
import { Notices } from '../session/Notices'
import { QueuedPrompts } from '../session/QueuedPrompts'
import { StatusBar } from '../session/StatusBar'
import { StatusHeader } from '../session/StatusHeader'
import { TranscriptView } from '../session/TranscriptView'
import { RewindDialog } from '../session/RewindDialog'
import type { AppliedSessionState } from '../state/eventApplier'

interface Toast {
  id: number
  text: string
  level: 'info' | 'error'
}

// SessionView is the single-session experience: slim status header with
// controls, virtualized transcript over reconciled state, dialog dock above a
// queue-aware composer, and a bottom status bar answering "what is the agent
// doing" at a glance. The workspace modes host it by sessionId; the /s/:sessionId
// route keeps a standalone focused view for deep links. autoFocusDialogs marks
// the surface that holds keyboard focus: dialogs take the caret there (head
// card, on mount) and render inert in background panes.
//
// The content keys on sessionId, so every host presents a swap as a remount:
// that session's own draft restores from the store while sheets, menus, toasts
// and scroll reset instead of bleeding across sessions
// (session-switch-state-reset.md).
export default function SessionView({
  sessionId: hostedId,
  autoFocusDialogs = true,
}: {
  sessionId?: string
  autoFocusDialogs?: boolean
}) {
  const params = useParams()
  const sessionId = hostedId ?? params.sessionId ?? ''
  return (
    <SessionSurface key={sessionId} sessionId={sessionId} autoFocusDialogs={autoFocusDialogs} />
  )
}

// SessionSurface is one session's mounted presentation; the key above makes a
// session swap a remount, so local state never outlives its session.
function SessionSurface({
  sessionId,
  autoFocusDialogs,
}: {
  sessionId: string
  autoFocusDialogs: boolean
}) {
  const { state, phase, loadOlder, dispatch } = useSessionChannel(sessionId)
  const { acknowledgeDialog, acknowledgeTurn } = useWorkspace()
  const snap = state.snapshot

  const { draft, setDraft, prefill } = useComposerDraft(sessionId)
  const [showRewind, setShowRewind] = useState(false)

  const [toasts, setToasts] = useState<Toast[]>([])
  const toastID = useRef(0)
  const pushToast = useCallback((text: string, level: 'info' | 'error' = 'info') => {
    const id = ++toastID.current
    setToasts((ts) => [...ts.slice(-4), { id, text, level }])
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 6_000)
  }, [])

  // placedAbove surfaces a prefill that merged above an existing draft, so the
  // arrival is noticed instead of reading as one's own text moving down.
  const placedAbove = useCallback(
    (text: string) => {
      if (prefill(text)) pushToast(placedAboveNotice, 'info')
    },
    [prefill, pushToast],
  )

  // Editing a queued prompt pops it back into the composer through recall;
  // secret rows refuse upstream and their toast says so.
  const recallToEdit = useCallback(async () => {
    try {
      const row = await sessionAPI.recall(sessionId)
      if (row.text) placedAbove(row.text)
    } catch (err) {
      pushToast(err instanceof ApiError ? err.message : 'Recall failed.', 'error')
    }
  }, [sessionId, pushToast, placedAbove])

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

      <TranscriptView
        sessionId={sessionId}
        state={state}
        loadOlder={loadOlder}
        onThinkingToggle={(open) => dispatch({ type: 'liveThinkingToggled', open })}
      />

      <Notices notices={state.notices} />
      <DialogDock
        sessionId={sessionId}
        dialogs={dialogs}
        outcomes={state.resolvedElsewhere}
        autoFocusDialogs={autoFocusDialogs}
        onAnsweredLocally={(dialogId) => {
          dispatch({ type: 'dialogAnswered', dialogId })
          acknowledgeDialog(sessionId, dialogId) // acting clears the queue row
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
          onPrefill={placedAbove} // a rewound prompt lands above the draft to edit
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

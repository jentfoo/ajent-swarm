import { useState } from 'react'
import { useParams } from 'react-router'

import { useSessionChannel } from '../hooks/useSessionChannel'
import { useWorkspace } from '../providers/workspace'
import { sessionBusy } from '../state/eventApplier'
import { Composer } from '../session/Composer'
import { phaseText } from '../session/phases'
import { DialogDock } from '../session/DialogDock'
import { Notices } from '../session/Notices'
import { QueuedPrompts } from '../session/QueuedPrompts'
import { SeatBadge } from '../session/SeatBadge'
import { StatusBar } from '../session/StatusBar'
import { StatusHeader } from '../session/StatusHeader'
import { TranscriptView } from '../session/TranscriptView'
import { RewindDialog } from '../session/RewindDialog'
import { useInterruptStream } from '../session/useInterruptStream'
import { useSessionCompose } from '../session/useSessionCompose'

// SessionView is the single-session experience: slim status header with
// controls, virtualized transcript over reconciled state, dialog dock above a
// queue-aware composer, and a bottom status bar answering "what is the agent
// doing" at a glance. The workspace modes host it by sessionId; the /s/:sessionId
// route keeps a standalone focused view for deep links. focused marks the
// surface that holds keyboard focus: dialogs take the caret there (head card,
// on mount), render inert in background panes, and its stream answers Escape
// with an interrupt.
//
// The content keys on sessionId, so every host presents a swap as a remount:
// that session's own draft restores from the store while sheets, menus, toasts
// and scroll reset instead of bleeding across sessions.
export default function SessionView({
  sessionId: hostedId,
  focused = true,
}: {
  sessionId?: string
  focused?: boolean
}) {
  const params = useParams()
  const sessionId = hostedId ?? params.sessionId ?? ''
  return <SessionSurface key={sessionId} sessionId={sessionId} focused={focused} />
}

// SessionSurface is one session's mounted presentation; the key above makes a
// session swap a remount, so local state never outlives its session.
function SessionSurface({ sessionId, focused }: { sessionId: string; focused: boolean }) {
  const { state, phase, loadOlder, dispatch } = useSessionChannel(sessionId)
  const { acknowledgeDialog, acknowledgeTurn } = useWorkspace()
  const snap = state.snapshot

  const {
    draft,
    setDraft,
    placedAbove,
    recallToEdit,
    dialogs,
    composerDisabled,
    disabledReason,
    toasts,
    pushToast,
  } = useSessionCompose(sessionId)
  const [showRewind, setShowRewind] = useState(false)

  // Escape interrupts the stream while this surface is the one being viewed;
  // only the focused tile pane binds it
  useInterruptStream({
    sessionId,
    busy: sessionBusy(snap),
    onToast: pushToast,
    enabled: focused,
  })

  return (
    <div className="session-screen">
      <StatusHeader sessionId={sessionId} snap={snap} onToast={pushToast}>
        <SeatBadge sessionId={sessionId} seat={snap.seat} />
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
        autoFocusDialogs={focused}
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

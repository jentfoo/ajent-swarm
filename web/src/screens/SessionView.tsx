import { useEffect, useState } from 'react'
import { useParams } from 'react-router'

import { Toasts } from '../hooks/Toasts'
import { useResume } from '../hooks/useResume'
import { useSessionChannel } from '../hooks/useSessionChannel'
import { useWorkspace } from '../providers/workspace'
import { sessionBusy } from '../state/eventApplier'
import { submitTurnEnd } from '../workspace/attention'
import { Composer } from '../session/Composer'
import { endedBanner, PhaseBanner } from '../session/phases'
import { DialogDock } from '../session/DialogDock'
import { Notices } from '../session/Notices'
import { QueuedPrompts } from '../session/QueuedPrompts'
import { SeatBadge } from '../session/SeatBadge'
import { StatusBar } from '../session/StatusBar'
import { StatusHeader } from '../session/StatusHeader'
import { TranscriptView } from '../session/TranscriptView'
import { RewindDialog } from '../session/RewindDialog'
import { useAgentJobs } from '../session/useAgentJobs'
import { useInterruptStream } from '../session/useInterruptStream'
import { useQueuedRecall } from '../session/useQueuedRecall'
import { useRewindGesture } from '../session/useRewindGesture'
import { useSessionCompose } from '../session/useSessionCompose'

// SessionView is the single-session experience: slim status header with
// controls, virtualized transcript over reconciled state, dialog dock above a
// queue-aware composer, and a bottom status bar answering "what is the agent
// doing" at a glance. The workspace modes host it by sessionId, the /s/:sessionId
// route keeps a standalone focused view for deep links. focused marks the
// surface that holds keyboard focus: dialogs take the caret there (head card,
// on mount), render inert in background panes, and its stream answers Escape
// with an interrupt, twice, while idle, with the rewind picker.
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

// SessionSurface is one session's mounted presentation, the key above makes a
// session swap a remount, so local state never outlives its session.
function SessionSurface({ sessionId, focused }: { sessionId: string; focused: boolean }) {
  const { state, phase, loadOlder, dispatch } = useSessionChannel(sessionId)
  const { acknowledgeDialog, acknowledgeTurn, itemFor } = useWorkspace()
  const snap = state.snapshot

  const {
    draft,
    setDraft,
    placedAbove,
    recall,
    recallToEdit,
    recallParked,
    dialogs,
    composerDisabled,
    disabledReason,
    toasts,
    pushToast,
  } = useSessionCompose(sessionId)
  const [showRewind, setShowRewind] = useState(false)

  const working = sessionBusy(snap)
  const ended = endedBanner(phase, state.exitReason)
  // the wire's queuedRows is optional, chips and the recall gate share one read
  const queuedRows = snap.queuedRows ?? []
  // sub-agent job records are pull-only: re-listed while any job is live, so
  // the chips band and poll cards carry stop controls and real statuses
  const agentJobs = useAgentJobs(sessionId, snap.activity, snap.status?.segments, pushToast)
  // Escape interrupts while this surface is being viewed, only the focused tile
  // pane binds it. The same guarded fire drives the composer's Stop button.
  const { interrupt, inFlight: stopBusy } = useInterruptStream({
    sessionId,
    busy: working,
    onToast: pushToast,
    enabled: focused,
  })

  // Esc Esc while at rest is ajent's rewind gesture: two presses inside the
  // window open the picker, one keeps every single-Esc meaning. A running turn,
  // a spinner, a pending dialog or an unreachable stream owns Escape instead,
  // and only the focused pane binds it. A draft never blocks the pair, matching
  // the TUI where idle means no turn rather than an empty editor.
  useRewindGesture({
    idle: !working && dialogs.length === 0 && phase === 'live',
    onRewind: () => setShowRewind(true),
    enabled: focused,
  })

  // Alt+ArrowUp recalls the newest queued prompt into the composer. An empty
  // queue leaves the press unclaimed, so tile mode's pane resize and every
  // other binding keep the key.
  useQueuedRecall({
    onRecall: () => void recallToEdit(),
    canRecall: !composerDisabled && queuedRows.length > 0,
    enabled: focused,
  })

  return (
    <div className="session-screen">
      <StatusHeader sessionId={sessionId} snap={snap} onToast={pushToast}>
        <SeatBadge sessionId={sessionId} seat={snap.seat} onToast={pushToast} />
        <button type="button" onClick={() => setShowRewind(true)}>
          Rewind
        </button>
      </StatusHeader>

      <PhaseBanner phase={phase} />
      {ended.show && (
        <div className="banner warn" role="status">
          {ended.text}{' '}
          <EndedResume sessionId={sessionId} workspace={snap.workspace} onToast={pushToast} />
        </div>
      )}

      <TranscriptView
        sessionId={sessionId}
        state={state}
        loadOlder={loadOlder}
        agentJobs={agentJobs}
        onThinkingToggle={(open) => dispatch({ type: 'liveThinkingToggled', open })}
      />

      <Notices notices={state.notices} />
      <DialogDock
        sessionId={sessionId}
        dialogs={dialogs}
        outcomes={state.resolvedElsewhere}
        ended={ended.show}
        autoFocusDialogs={focused}
        onAnsweredLocally={(dialogId) => {
          dispatch({ type: 'dialogAnswered', dialogId })
          acknowledgeDialog(sessionId, dialogId) // acting clears the queue row
        }}
        onOutcomeDismissed={(dialogId) => dispatch({ type: 'outcomeDismissed', dialogId })}
      />
      <QueuedPrompts
        queuedRows={queuedRows}
        parkedRows={snap.parkedRows}
        pendings={state.pendings}
        droppedRows={state.droppedRows}
        onEdit={() => void recallToEdit()}
        onEditParked={() => void recallParked()}
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
          // Sending feedback counts as acting: the raised review row's
          // server turn end settles, a later turn will re-raise.
          acknowledgeTurn(sessionId, submitTurnEnd(itemFor(sessionId)))
        }}
        onSubmitFailed={(pendingId) => dispatch({ type: 'pendingFailed', pendingId })}
        onQueue={(line, pendingId) =>
          dispatch({ type: 'pendingSubmitted', pendingId, text: line, parked: true })
        }
        onQueueFailed={(pendingId) => dispatch({ type: 'pendingFailed', pendingId })}
        recall={recall}
        stop={working ? { onClick: interrupt, busy: stopBusy } : undefined}
      />

      <StatusBar snap={snap} live={state.live} />

      <Toasts toasts={toasts} />
    </div>
  )
}

// EndedResume offers the shared resume path beside the ended banner's text,
// with refusals landing in this surface's toast stack. Without a recorded
// workspace there is nowhere to relaunch, so the hint says so instead of
// hiding the control.
function EndedResume({
  sessionId,
  workspace,
  onToast,
}: {
  sessionId: string
  workspace: string
  onToast: (text: string, level?: 'info' | 'error') => void
}) {
  const { resume, resumingId, error } = useResume()

  // useResume owns the failure text, the toast stack surfaces it here
  useEffect(() => {
    if (error !== '') onToast(error, 'error')
  }, [error, onToast])

  if (workspace === '') {
    return <span className="muted">No recorded workspace, so this session cannot be resumed.</span>
  }

  return (
    <button
      type="button"
      className="primary"
      disabled={resumingId !== null}
      onClick={() => void resume(workspace, sessionId)}
    >
      {resumingId !== null ? 'Resuming…' : 'Resume'}
    </button>
  )
}

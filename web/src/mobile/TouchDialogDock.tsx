import type { ReactElement } from 'react'

import type { InteractionPending } from '../api/types'
import type { DialogOutcome } from '../state/eventApplier'
import { ResolvedChip } from '../session/DialogBodies'
import { DialogCardBody } from '../session/DialogCardBody'
import { usePermitNoteAutoAnswer } from '../session/decisionNote'

// TouchDialogDock stacks full-width dialog cards above the composer through
// the shared DialogCardBody: permit and deny answer as separate large buttons,
// never a compact one-liner against 44px touch targets, and secret dialogs
// take over a dedicated screen with show and hide. A typed permit note rides
// the Allow or Deny tap, which answers at once and records a pending intent so
// the barrier's follow-up ask auto-resolves (decisionNote.ts) instead of
// reading as required input. Answered-elsewhere chips read their detail inline
// and leave on their own or on tap.
export function TouchDialogDock({
  sessionId,
  dialogs,
  outcomes,
  onAnsweredLocally,
  onOutcomeDismissed,
}: {
  sessionId: string
  dialogs: InteractionPending[]
  outcomes: DialogOutcome[]
  onAnsweredLocally: (dialogId: number) => void
  onOutcomeDismissed: (dialogId: number) => void
}): ReactElement | null {
  const { suppressed, recordIntent } = usePermitNoteAutoAnswer(
    sessionId,
    dialogs,
    onAnsweredLocally,
  )
  const visible = dialogs.filter((dlg) => !suppressed.has(dlg.id))
  if (visible.length === 0 && outcomes.length === 0) return null

  return (
    <section className="dialog-dock touch" aria-label="Open dialogs">
      {visible.map((dlg) => (
        <DialogCardBody
          key={dlg.id}
          dialog={dlg}
          sessionId={sessionId}
          layout="touch"
          onAnsweredLocally={onAnsweredLocally}
          onNoteIntent={recordIntent}
        />
      ))}
      {outcomes.map((o) => (
        <ResolvedChip
          key={`outcome-${o.id}`}
          outcome={o}
          onDismiss={onOutcomeDismissed}
          inlineDetail
        />
      ))}
    </section>
  )
}

import type { ReactElement } from 'react'

import type { InteractionPending } from '../api/types'
import type { DialogOutcome } from '../state/eventApplier'
import { ResolvedChip } from './DialogBodies'
import { DialogCardBody } from './DialogCardBody'
import { usePermitNoteAutoAnswer } from './decisionNote'

// DialogDock sits above the composer and lists open dialogs oldest first.
// Cards render through the shared DialogCardBody, this shell owns placement
// and the focus policy: autofocus belongs to the focused pane only
// (dialog-focus-policy.md), its head card takes the caret on mount, later
// arrivals and background panes never steal it. Digits follow the same rule:
// while the focused head card answers by option index, 1..9 pick that option
// (dialogKeys.ts). A dialog answered elsewhere shows its real outcome as a
// resolved chip that leaves on click or after a moment.
export function DialogDock({
  sessionId,
  dialogs,
  outcomes,
  autoFocusDialogs = true,
  onAnsweredLocally,
  onOutcomeDismissed,
}: {
  sessionId: string
  dialogs: InteractionPending[]
  outcomes: DialogOutcome[]
  autoFocusDialogs?: boolean
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
    <section className="dialog-dock" aria-label="Open dialogs">
      {visible.map((dlg, i) => (
        <DialogCardBody
          key={dlg.id}
          dialog={dlg}
          sessionId={sessionId}
          layout="compact"
          head={autoFocusDialogs && i === 0}
          onAnsweredLocally={onAnsweredLocally}
          onNoteIntent={recordIntent}
        />
      ))}
      {outcomes.map((o) => (
        <ResolvedChip key={`outcome-${o.id}`} outcome={o} onDismiss={onOutcomeDismissed} />
      ))}
    </section>
  )
}
